import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaWorkspaceMemberDirectoryStore } from "#src/server/workspaces/member-directory-store.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { conversationRealtimeChannel } from "#src/features/conversations/conversation-realtime";

/**
 * Every write that changes who is in a channel tells the channel's open pages that their member
 * list is stale, so the composer's @-list never needs a page refresh. Drives the real services
 * and Prisma stores against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type Announcement = { workspaceId: string; conversationIds: readonly string[] };

function recordingRealtime() {
  const announced: Announcement[] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged(input) {
      announced.push(input);
    },
  };
  return { realtime, announced };
}

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `mc-owner-${suffix}` } });
  const bob = await db.user.create({ data: { username: `mc-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `mc-${suffix}`,
      name: "Member changes",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: bob.id, role: "member" },
        ],
      },
    },
  });
  const createAgent = (name: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: owner.id,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
  const helper = await createAgent("helper");
  const scout = await createAgent("scout");
  const { realtime } = recordingRealtime();
  const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
  const teamName = `team-${suffix}`;
  const team = await channels.create(workspace.id, owner.id, teamName);
  const ops = await channels.create(workspace.id, owner.id, `ops-${suffix}`);
  return { db, workspace, owner, bob, helper, scout, team, teamName, ops };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

test.skipIf(!connectionString)(
  "joining, adding, removing and leaving each tell the channel its member list changed",
  async () => {
    const { db, workspace, owner, bob, helper, team } = await setup();
    try {
      const { realtime, announced } = recordingRealtime();
      const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
      const change = { workspaceId: workspace.id, conversationIds: [team.id] };

      await channels.join(workspace.id, bob.id, team.id);
      await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
        userIds: [],
        agentIds: [helper.id],
      });
      // Adding someone who is already in the channel changes nothing, so it announces nothing.
      await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
        userIds: [bob.id],
        agentIds: [],
      });
      await channels.removeMember(workspace.id, owner.id, team.id, { agentId: helper.id });
      await channels.leave(workspace.id, bob.id, team.id);

      expect(announced).toEqual([change, change, change, change]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a channel service built without a realtime publisher still announces through Centrifugo",
  async () => {
    const published: unknown[] = [];
    const centrifugo = Bun.serve({
      port: 0,
      async fetch(request) {
        published.push(await request.json());
        return Response.json({ result: {} });
      },
    });
    const env = {
      url: process.env.COFORGE_CENTRIFUGO_API_URL,
      key: process.env.COFORGE_CENTRIFUGO_API_KEY,
    };
    process.env.COFORGE_CENTRIFUGO_API_URL = `http://127.0.0.1:${centrifugo.port}/api`;
    process.env.COFORGE_CENTRIFUGO_API_KEY = "test-key";
    const { db, workspace, owner, bob, team } = await setup();
    try {
      // The page's server functions build the service like this, with no publisher injected.
      await new PublicChannels(db).join(workspace.id, bob.id, team.id);

      expect(published).toEqual([
        {
          method: "publish",
          params: {
            channel: conversationRealtimeChannel(team.id),
            data: {
              type: "member.changed.v1",
              conversationId: team.id,
              workspaceId: workspace.id,
            },
            idempotency_key: expect.any(String),
          },
        },
      ]);
    } finally {
      process.env.COFORGE_CENTRIFUGO_API_URL = env.url;
      process.env.COFORGE_CENTRIFUGO_API_KEY = env.key;
      await centrifugo.stop(true);
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "an Agent joining, adding, removing and leaving through the CLI tells the channel too",
  async () => {
    const { db, workspace, owner, bob, helper, scout, team, teamName } = await setup();
    try {
      const { realtime, announced } = recordingRealtime();
      const management = new AgentChannelManagement(db, undefined, undefined, realtime);
      const target = `#${teamName}`;
      const change = { workspaceId: workspace.id, conversationIds: [team.id] };

      await management.join(workspace.id, helper.id, target);
      await management.addMember(workspace.id, helper.id, target, { agent: `@${scout.name}` });
      await management.removeMember(workspace.id, scout.id, target, { agent: `@${scout.name}` });
      await management.leave(workspace.id, helper.id, target);
      // Leaving a channel the Agent is no longer in changes nothing.
      await management.leave(workspace.id, helper.id, target);

      expect(announced).toEqual([change, change, change, change]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "deleting an Agent, making it private and removing a person each report the channels they left",
  async () => {
    const { db, workspace, owner, bob, helper, scout, team, ops } = await setup();
    try {
      const channels = new PublicChannels(
        db,
        undefined,
        undefined,
        undefined,
        recordingRealtime().realtime,
      );
      for (const channel of [team, ops]) {
        await channels.addMembers(workspace.id, { userId: owner.id }, channel.id, {
          userIds: [bob.id],
          agentIds: [helper.id, scout.id],
        });
      }
      // A direct conversation is not a channel: no page shows it a channel member list.
      const directMessages = new PrismaDirectConversationRepository(db);
      await directMessages.getOrCreateUserAgent(workspace.id, owner.id, helper.id);
      await directMessages.getOrCreateUserAgent(workspace.id, bob.id, helper.id);
      const sorted = (ids: readonly string[]) => [...ids].sort();

      const deleted = await new PrismaAgentDeletionStore(db).delete({
        agentId: helper.id,
        workspaceId: workspace.id,
        deletedAt: new Date(),
      });
      expect(deleted.outcome === "deleted" && sorted(deleted.leftChannelIds)).toEqual(
        sorted([team.id, ops.id]),
      );

      const madePrivate = await new PrismaChangeAgentVisibilityStore(db).apply({
        agentId: scout.id,
        workspaceId: workspace.id,
        visibility: "private",
      });
      expect(sorted(madePrivate.leftChannelIds)).toEqual(sorted([team.id, ops.id]));

      await channels.leave(workspace.id, bob.id, ops.id);
      const removed = await new PrismaWorkspaceMemberDirectoryStore(db).removeMember(
        workspace.id,
        bob.id,
      );
      expect(removed.leftChannelIds).toEqual([team.id]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);
