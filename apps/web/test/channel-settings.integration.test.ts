import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PublicChannels,
  enrollGeneralChannel,
} from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { isAppError } from "#src/lib/app-error";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";

/**
 * The channel settings panel's writes: renaming, describing, archiving and unarchiving a channel
 * as a human, and what opening a channel tells the panel. Drives the real `PublicChannels` against
 * local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

/** Records which channels were announced as renamed, described, archived or unarchived. */
function recordingRealtime() {
  const updated: { workspaceId: string; conversationId: string }[] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged() {},
    async channelUpdated(input) {
      updated.push(input);
    },
  };
  return { realtime, updated };
}

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `cs-owner-${suffix}` } });
  const creator = await db.user.create({ data: { username: `cs-creator-${suffix}` } });
  const bob = await db.user.create({ data: { username: `cs-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `cs-${suffix}`,
      name: "Channel settings",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: creator.id, role: "member" },
          { userId: bob.id, role: "member" },
        ],
      },
    },
  });
  await enrollGeneralChannel(db, workspace.id);
  const general = await db.conversation.findUniqueOrThrow({
    where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
  });
  const { realtime, updated } = recordingRealtime();
  const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
  const team = await channels.create(workspace.id, creator.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  return { db, channels, updated, suffix, workspace, owner, creator, bob, general, team };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

async function appErrorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

test.skipIf(!connectionString)(
  "a channel admin renames and describes a channel; a plain member cannot; names stay valid and unique; #general keeps its name",
  async () => {
    const { db, channels, suffix, workspace, owner, creator, bob, general, team } = await setup();
    try {
      // The creator is the channel's admin, so they edit both fields.
      const renamed = await channels.updateInfo(workspace.id, { userId: creator.id }, team.id, {
        name: `crew-${suffix}`,
        description: "Where the crew talks",
      });
      expect(renamed).toEqual({
        id: team.id,
        name: `crew-${suffix}`,
        description: "Where the crew talks",
      });
      const opened = await channels.open(workspace.id, bob.id, team.id);
      expect(opened.name).toBe(`crew-${suffix}`);
      expect(opened.description).toBe("Where the crew talks");

      // A plain member edits nothing.
      expect(
        await appErrorCode(
          channels.updateInfo(workspace.id, { userId: bob.id }, team.id, { description: "mine" }),
        ),
      ).toBe("ACCESS_DENIED");

      // The name follows the creation rule, and another channel's name is taken.
      expect(
        await appErrorCode(
          channels.updateInfo(workspace.id, { userId: creator.id }, team.id, { name: "Bad Name" }),
        ),
      ).toBe("INVALID_INPUT");
      await channels.create(workspace.id, creator.id, `other-${suffix}`);
      expect(
        await appErrorCode(
          channels.updateInfo(workspace.id, { userId: creator.id }, team.id, {
            name: `other-${suffix}`,
          }),
        ),
      ).toBe("CONFLICT");
      expect(
        await appErrorCode(
          channels.updateInfo(workspace.id, { userId: creator.id }, team.id, { name: "general" }),
        ),
      ).toBe("CONFLICT");

      // #general cannot be renamed, but a Workspace admin still edits its description.
      expect(
        await appErrorCode(
          channels.updateInfo(workspace.id, { userId: owner.id }, general.id, {
            name: `renamed-${suffix}`,
          }),
        ),
      ).toBe("CONFLICT");
      const described = await channels.updateInfo(workspace.id, { userId: owner.id }, general.id, {
        description: "Everyone",
      });
      expect(described).toMatchObject({ name: "general", description: "Everyone" });
    } finally {
      await teardown(db, workspace.id, [owner.id, creator.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a channel admin archives and unarchives a channel; an archived channel refuses posts and new joins; #general is never archived",
  async () => {
    const { db, channels, workspace, owner, creator, bob, general, team } = await setup();
    try {
      expect(
        await appErrorCode(channels.setArchived(workspace.id, { userId: bob.id }, team.id, true)),
      ).toBe("ACCESS_DENIED");

      expect(
        await channels.setArchived(workspace.id, { userId: creator.id }, team.id, true),
      ).toEqual({ id: team.id, archived: true });
      const archived = await channels.open(workspace.id, bob.id, team.id);
      expect(archived.archived).toBe(true);
      expect(
        await appErrorCode(
          channels.send({
            workspaceId: workspace.id,
            userId: bob.id,
            channelId: team.id,
            requestId: crypto.randomUUID(),
            body: "still here?",
          }),
        ),
      ).toBe("CONFLICT");
      // A Workspace member outside the channel cannot join it while it is archived, nobody adds
      // members to it, and its name and description are frozen too.
      expect(await appErrorCode(channels.join(workspace.id, owner.id, team.id))).toBe("CONFLICT");
      expect(
        await appErrorCode(
          channels.addMembers(workspace.id, { userId: bob.id }, team.id, {
            userIds: [owner.id],
            agentIds: [],
          }),
        ),
      ).toBe("CONFLICT");
      expect(
        (await channels.members(workspace.id, { userId: bob.id }, team.id)).canAddMembers,
      ).toBe(false);
      expect(
        await appErrorCode(
          channels.updateInfo(workspace.id, { userId: creator.id }, team.id, {
            description: "frozen",
          }),
        ),
      ).toBe("CONFLICT");

      expect(
        await channels.setArchived(workspace.id, { userId: creator.id }, team.id, false),
      ).toEqual({ id: team.id, archived: false });
      expect((await channels.open(workspace.id, bob.id, team.id)).archived).toBe(false);
      await channels.join(workspace.id, owner.id, team.id);

      expect(
        await appErrorCode(
          channels.setArchived(workspace.id, { userId: owner.id }, general.id, true),
        ),
      ).toBe("CONFLICT");
    } finally {
      await teardown(db, workspace.id, [owner.id, creator.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "opening a channel tells the viewer whether it is pinned for them and which settings they may change",
  async () => {
    const { db, channels, workspace, owner, creator, bob, general, team } = await setup();
    try {
      await channels.setUserPinned(workspace.id, bob.id, team.id, true);
      const asMember = await channels.open(workspace.id, bob.id, team.id);
      expect(asMember.pinned).toBe(true);
      expect(asMember.channelCapabilities).toMatchObject({
        leave: true,
        update: false,
        archive: false,
      });

      const asAdmin = await channels.open(workspace.id, creator.id, team.id);
      expect(asAdmin.pinned).toBe(false);
      expect(asAdmin.channelCapabilities).toMatchObject({
        leave: true,
        update: true,
        archive: true,
      });

      // #general: a Workspace admin edits its description but never archives it or leaves it.
      const generalAsOwner = await channels.open(workspace.id, owner.id, general.id);
      expect(generalAsOwner.channelCapabilities).toMatchObject({
        leave: false,
        update: true,
        archive: false,
      });
    } finally {
      await teardown(db, workspace.id, [owner.id, creator.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "an Agent without admin authority is refused before its channel update input is judged",
  async () => {
    const { db, channels, workspace, owner, creator, bob, team } = await setup();
    try {
      const agent = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `cs-agent-${team.id.slice(0, 8)}`,
          displayName: "Settings agent",
          ownerId: bob.id,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      const channel = await db.conversation.findUniqueOrThrow({ where: { id: team.id } });
      const management = new AgentChannelManagement(db, undefined, channels);
      for (const patch of [{ name: "Bad Name" }, { name: "general" }]) {
        const refused = await management
          .update(workspace.id, agent.id, `#${channel.channelName}`, patch)
          .then(
            () => undefined,
            (error: { status?: number }) => error.status,
          );
        expect(refused).toBe(403);
      }
      const renameGeneral = await management
        .update(workspace.id, agent.id, "#general", { name: "elsewhere" })
        .then(
          () => undefined,
          (error: { status?: number }) => error.status,
        );
      expect(renameGeneral).toBe(403);
    } finally {
      await teardown(db, workspace.id, [owner.id, creator.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "every open page of the Workspace hears when a channel is renamed, described, archived or unarchived; a refused write announces nothing",
  async () => {
    const { db, channels, updated, suffix, workspace, owner, creator, bob, team } = await setup();
    try {
      const announcement = { workspaceId: workspace.id, conversationId: team.id };
      await channels.updateInfo(workspace.id, { userId: creator.id }, team.id, {
        name: `renamed-${suffix}`,
      });
      await channels.updateInfo(workspace.id, { userId: creator.id }, team.id, {
        description: "Now described",
      });
      await channels.setArchived(workspace.id, { userId: creator.id }, team.id, true);
      await channels.setArchived(workspace.id, { userId: creator.id }, team.id, false);
      expect(updated).toEqual([announcement, announcement, announcement, announcement]);

      await appErrorCode(
        channels.updateInfo(workspace.id, { userId: bob.id }, team.id, { description: "no" }),
      );
      await appErrorCode(channels.setArchived(workspace.id, { userId: bob.id }, team.id, true));
      expect(updated).toHaveLength(4);
    } finally {
      await teardown(db, workspace.id, [owner.id, creator.id, bob.id]);
    }
  },
);
