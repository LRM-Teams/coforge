import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  generalChannelForCreator,
  PublicChannels,
} from "#src/server/conversations/public-channels.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { WorkspaceJoinLinks } from "#src/server/workspaces/join-links.server";
import { PrismaWorkspaceJoinLinkStore } from "#src/server/workspaces/join-links-store.server";

/**
 * Joining a Workspace by a link, against local PostgreSQL: the visitor becomes an ordinary
 * member in `#general`, and a link's use limit holds however many people join at once.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `jl-owner-${suffix}` } });
  const ada = await db.user.create({ data: { username: `jl-ada-${suffix}` } });
  const bob = await db.user.create({ data: { username: `jl-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `jl-${suffix}`,
      name: "Join links",
      members: { create: { userId: owner.id, role: "owner" } },
      conversations: generalChannelForCreator(owner.id),
    },
  });
  const general = await db.conversation.findUniqueOrThrow({
    where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
  });
  const announced: Array<{ workspaceId: string; conversationIds: readonly string[] }> = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged(input) {
      announced.push(input);
    },
  };
  const links = new WorkspaceJoinLinks(new PrismaWorkspaceJoinLinkStore(db), undefined, realtime);
  const channels = new PublicChannels(db, passThrough, undefined, undefined, realtime);
  const generalHumans = async () =>
    (await channels.members(workspace.id, { userId: owner.id }, general.id)).humans
      .map((human) => human.id)
      .sort();
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [owner.id, ada.id, bob.id] } } }).catch(() => {});
    await db.$disconnect();
  };
  return {
    db,
    links,
    realtime,
    announced,
    generalHumans,
    teardown,
    workspace,
    general,
    owner,
    ada,
    bob,
  };
}

const roleOf = (db: PrismaClient, workspaceId: string, userId: string) =>
  db.workspaceMembership
    .findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { role: true } })
    .then((row) => row?.role ?? null);

test.skipIf(!connectionString)(
  "a visitor who joins by a link is an ordinary member, in #general, and #general hears of it",
  async () => {
    const { db, links, announced, generalHumans, teardown, workspace, general, owner, ada } =
      await setup();
    try {
      await db.agent.createMany({
        data: [
          {
            workspaceId: workspace.id,
            ownerId: owner.id,
            name: `jl-pub-${workspace.slug}`,
            displayName: "Public",
            runtimeConfig: {},
          },
          {
            workspaceId: workspace.id,
            ownerId: owner.id,
            name: `jl-priv-${workspace.slug}`,
            displayName: "Private",
            runtimeConfig: {},
            visibility: "private",
          },
          {
            workspaceId: workspace.id,
            ownerId: owner.id,
            name: `jl-gone-${workspace.slug}`,
            displayName: "Gone",
            runtimeConfig: {},
            deletedAt: new Date(),
          },
        ],
      });
      const link = await links.create({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        maxUses: null,
        expiresAt: null,
      });

      expect(await links.inspect({ token: link.token, viewerUserId: ada.id })).toEqual({
        workspace: { slug: workspace.slug, name: "Join links", iconUrl: null },
        memberCount: 1,
        agentCount: 1,
        viewerIsMember: false,
      });

      expect(await links.join({ token: link.token, userId: ada.id })).toEqual({
        workspaceId: workspace.id,
        slug: workspace.slug,
      });

      expect(await roleOf(db, workspace.id, ada.id)).toBe("member");
      expect(await generalHumans()).toEqual([owner.id, ada.id].sort());
      expect(announced).toEqual([{ workspaceId: workspace.id, conversationIds: [general.id] }]);
      expect(
        await links.current({ workspaceId: workspace.id, actorUserId: owner.id }),
      ).toMatchObject({ id: link.id, useCount: 1 });
      expect(
        (await links.inspect({ token: link.token, viewerUserId: ada.id })).viewerIsMember,
      ).toBe(true);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "two people joining at once by a single-use link: exactly one gets in",
  async () => {
    const { db, links, generalHumans, teardown, workspace, owner, ada, bob } = await setup();
    try {
      const link = await links.create({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        maxUses: 1,
        expiresAt: null,
      });

      const results = await Promise.allSettled([
        links.join({ token: link.token, userId: ada.id }),
        links.join({ token: link.token, userId: bob.id }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused?.status === "rejected" && refused.reason).toMatchObject({ code: "NOT_FOUND" });
      const roles = [
        await roleOf(db, workspace.id, ada.id),
        await roleOf(db, workspace.id, bob.id),
      ];
      expect(roles.filter((role) => role === "member")).toHaveLength(1);
      expect(roles.filter((role) => role === null)).toHaveLength(1);
      expect(await generalHumans()).toHaveLength(2);
      expect(await links.current({ workspaceId: workspace.id, actorUserId: owner.id })).toBeNull();
      await expect(links.inspect({ token: link.token })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the same person opening a link twice at once joins once and uses it once",
  async () => {
    const { db, links, teardown, workspace, owner, ada } = await setup();
    try {
      const link = await links.create({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        maxUses: 5,
        expiresAt: null,
      });

      const landings = await Promise.all([
        links.join({ token: link.token, userId: ada.id }),
        links.join({ token: link.token, userId: ada.id }),
      ]);

      expect(landings).toEqual([
        { workspaceId: workspace.id, slug: workspace.slug },
        { workspaceId: workspace.id, slug: workspace.slug },
      ]);
      expect(await roleOf(db, workspace.id, ada.id)).toBe("member");
      expect(
        await links.current({ workspaceId: workspace.id, actorUserId: owner.id }),
      ).toMatchObject({ useCount: 1 });
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "two links created at once leave exactly one that admits anyone",
  async () => {
    const { db, links, teardown, workspace, owner } = await setup();
    try {
      const created = await Promise.all(
        [0, 1, 2].map(() =>
          links.create({
            workspaceId: workspace.id,
            actorUserId: owner.id,
            maxUses: null,
            expiresAt: null,
          }),
        ),
      );

      const working = await db.workspaceJoinLink.findMany({
        where: { workspaceId: workspace.id, revokedAt: null },
      });
      expect(working).toHaveLength(1);
      expect(created.map((link) => link.id)).toContain(working[0]!.id);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "updating a link stops the old URL at once; revoking stops the new one",
  async () => {
    const { links, teardown, workspace, owner, ada } = await setup();
    try {
      const old = await links.create({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        maxUses: null,
        expiresAt: null,
      });
      const replacement = await links.replace({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        linkId: old.id,
        maxUses: 3,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      await expect(links.join({ token: old.token, userId: ada.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await links.current({ workspaceId: workspace.id, actorUserId: owner.id })).toEqual(
        replacement,
      );

      await links.revoke({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        linkId: replacement.id,
      });
      expect(await links.current({ workspaceId: workspace.id, actorUserId: owner.id })).toBeNull();
      await expect(links.inspect({ token: replacement.token })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await teardown();
    }
  },
);
