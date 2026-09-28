import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import { ChangeAgentVisibility } from "#src/server/agents/change-agent-visibility.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { decodeAgentInboxPurge, type AgentInboxPurgeReason } from "@lrm/coforge-sdk/internal";

/**
 * An Agent that leaves a channel, is removed from one, or goes private stops receiving that
 * channel's pending messages: the server tells its daemon to drop them, and a daemon `ready`
 * replay no longer resends them. Drives the real services and Prisma stores against local
 * PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
/** Each test drives several real transactions against PostgreSQL. */
const TIMEOUT_MS = 30_000;

/** Records every binary publication; `purges` decodes the inbox purges among them. */
function recordingCentrifugo() {
  const published: Array<{ channel: string; payload: Uint8Array }> = [];
  let failNext = false;
  const api: CentrifugoServerApi = {
    async publish(channel, payload) {
      if (failNext) {
        failNext = false;
        throw new Error("controlled publish outage");
      }
      published.push({ channel, payload });
    },
    async publishJson() {},
    async broadcast() {},
  };
  const purges = () =>
    published.flatMap(({ channel, payload }) => {
      try {
        return [{ channel, purge: decodeAgentInboxPurge(payload) }];
      } catch {
        return [];
      }
    });
  return { api, published, purges, failNextPublish: () => (failNext = true) };
}

/** The purge a daemon should receive, minus the per-publication request id. */
function expectedPurge(input: {
  workspaceId: string;
  computerId: string;
  agentId: string;
  channels: Array<{ id: string; name: string }>;
  reason: AgentInboxPurgeReason;
}) {
  return {
    channel: daemonControlChannel(input.workspaceId, input.computerId),
    purge: {
      protocolMajor: 1,
      requestId: expect.any(String),
      workspaceId: input.workspaceId,
      computerId: input.computerId,
      agentId: input.agentId,
      conversationIds: input.channels.map((channel) => channel.id),
      targets: input.channels.map((channel) => `#${channel.name}`),
      reason: input.reason,
    },
  };
}

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `ip-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ip-${suffix}`,
      name: "Inbox purge",
      members: { create: [{ userId: owner.id, role: "owner" }] },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: crypto.randomUUID(), name: `box-${suffix}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const createAgent = (name: string, computerId: string | null) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: owner.id,
        computerId,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
  const helper = await createAgent("helper", computer.id);
  const centrifugo = recordingCentrifugo();
  const channels = new PublicChannels(
    db,
    { execute: async (_scope, persist) => persist() },
    centrifugo.api,
    undefined,
    { async messageAvailable() {}, async memberChanged() {} },
  );
  const teamName = `team-${suffix}`;
  const team = await channels.create(workspace.id, owner.id, teamName);
  const opsName = `ops-${suffix}`;
  const ops = await channels.create(workspace.id, owner.id, opsName);
  for (const channel of [team, ops])
    await channels.addMembers(workspace.id, { userId: owner.id }, channel.id, {
      userIds: [],
      agentIds: [helper.id],
    });
  centrifugo.published.length = 0;
  return {
    db,
    channels,
    centrifugo,
    createAgent,
    workspace,
    owner,
    computer,
    helper,
    team,
    teamName,
    ops,
    opsName,
  };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.computer.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

test.skipIf(!connectionString)(
  "a daemon ready replay skips pending messages of a channel the Agent has left, but keeps its direct messages",
  async () => {
    const { db, channels, workspace, owner, helper, team, ops } = await setup();
    try {
      const mention = (channelId: string) =>
        channels.send({
          workspaceId: workspace.id,
          userId: owner.id,
          channelId,
          requestId: crypto.randomUUID(),
          body: `@${helper.name} please look`,
        });
      await mention(team.id);
      const kept = await mention(ops.id);
      const conversations = new PrismaDirectConversationRepository(db);
      const direct = await conversations.getOrCreateUserAgent(workspace.id, owner.id, helper.id);
      const directMember = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: direct.id, userId: owner.id } },
        select: { id: true },
      });
      const directMessage = await conversations.sendMessage(
        direct.id,
        directMember.id,
        owner.id,
        "a direct question",
      );

      await channels.removeMember(workspace.id, owner.id, team.id, { agentId: helper.id });

      const pending = await conversations.readPendingAgentDeliveries(workspace.id, helper.id);
      expect(pending.map((delivery) => delivery.messageId)).toEqual([kept.id, directMessage.id]);
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!connectionString)(
  "removing an Agent from a channel tells its daemon to drop that channel's pending messages",
  async () => {
    const {
      db,
      channels,
      centrifugo,
      createAgent,
      workspace,
      owner,
      computer,
      helper,
      team,
      teamName,
    } = await setup();
    const bob = await db.user.create({
      data: { username: `ip-bob-${crypto.randomUUID().slice(0, 8)}` },
    });
    try {
      await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: bob.id } });
      await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
        userIds: [bob.id],
        agentIds: [],
      });
      const unplaced = await createAgent("unplaced", null);
      await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
        userIds: [],
        agentIds: [unplaced.id],
      });
      centrifugo.published.length = 0;

      await channels.removeMember(workspace.id, owner.id, team.id, { agentId: helper.id });
      // A person has no daemon, and an Agent on no Computer has none to tell.
      await channels.removeMember(workspace.id, owner.id, team.id, { userId: bob.id });
      await channels.removeMember(workspace.id, owner.id, team.id, { agentId: unplaced.id });
      // Removing an Agent that already left changes nothing.
      await channels.removeMember(workspace.id, owner.id, team.id, { agentId: helper.id });

      expect(centrifugo.purges()).toEqual([
        expectedPurge({
          workspaceId: workspace.id,
          computerId: computer.id,
          agentId: helper.id,
          channels: [{ id: team.id, name: teamName }],
          reason: "member_removed",
        }),
      ]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!connectionString)(
  "an Agent leaving a channel through the CLI tells its own daemon, even when an earlier purge could not be sent",
  async () => {
    const { db, centrifugo, workspace, owner, computer, helper, team, teamName, opsName } =
      await setup();
    try {
      const management = new AgentChannelManagement(
        db,
        undefined,
        undefined,
        { async messageAvailable() {}, async memberChanged() {} },
        new AgentInboxPurgePublisher(db, centrifugo.api),
      );

      centrifugo.failNextPublish();
      // The leave has already happened when the purge fails, so the Agent still hears it left.
      expect(await management.leave(workspace.id, helper.id, `#${opsName}`)).toMatchObject({
        wasMember: true,
      });
      await management.leave(workspace.id, helper.id, `#${teamName}`);
      // Leaving a channel the Agent is no longer in changes nothing.
      await management.leave(workspace.id, helper.id, `#${teamName}`);

      expect(centrifugo.purges()).toEqual([
        expectedPurge({
          workspaceId: workspace.id,
          computerId: computer.id,
          agentId: helper.id,
          channels: [{ id: team.id, name: teamName }],
          reason: "left",
        }),
      ]);
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!connectionString)(
  "a channel admin Agent removing another Agent tells the removed Agent's daemon; removing a person tells none",
  async () => {
    const {
      db,
      channels,
      centrifugo,
      createAgent,
      workspace,
      owner,
      computer,
      helper,
      team,
      teamName,
    } = await setup();
    const bob = await db.user.create({
      data: { username: `ip-bob-${crypto.randomUUID().slice(0, 8)}` },
    });
    try {
      await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: bob.id } });
      const scout = await createAgent("scout", computer.id);
      await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
        userIds: [bob.id],
        agentIds: [scout.id],
      });
      await db.conversationMember.update({
        where: { conversationId_agentId: { conversationId: team.id, agentId: helper.id } },
        data: { channelRole: "admin" },
      });
      const management = new AgentChannelManagement(
        db,
        undefined,
        undefined,
        { async messageAvailable() {}, async memberChanged() {} },
        new AgentInboxPurgePublisher(db, centrifugo.api),
      );
      centrifugo.published.length = 0;

      await management.removeMember(workspace.id, helper.id, `#${teamName}`, {
        agent: `@${scout.name}`,
      });
      await management.removeMember(workspace.id, helper.id, `#${teamName}`, {
        user: `@${bob.username}`,
      });

      expect(centrifugo.purges()).toEqual([
        expectedPurge({
          workspaceId: workspace.id,
          computerId: computer.id,
          agentId: scout.id,
          channels: [{ id: team.id, name: teamName }],
          reason: "member_removed",
        }),
      ]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!connectionString)(
  "making an Agent private tells its daemon, in one purge, to drop every channel it left",
  async () => {
    const { db, centrifugo, workspace, owner, computer, helper, team, teamName, ops, opsName } =
      await setup();
    try {
      const changeVisibility = new ChangeAgentVisibility(
        new PrismaAgentRepository(db),
        new PrismaChangeAgentVisibilityStore(db),
        async () => {},
        new AgentInboxPurgePublisher(db, centrifugo.api),
        { async memberChanged() {} },
      );

      await changeVisibility.execute(
        { userId: owner.id, workspaceId: workspace.id, role: "owner" },
        { agentId: helper.id, visibility: "private" },
      );

      // The store leaves channels in no particular order, so compare in the order the purge used;
      // each id must still sit beside its own target.
      const names = new Map([
        [team.id, teamName],
        [ops.id, opsName],
      ]);
      const [only, ...others] = centrifugo.purges();
      expect(others).toEqual([]);
      expect([...only!.purge.conversationIds].sort()).toEqual([...names.keys()].sort());
      expect(only).toEqual(
        expectedPurge({
          workspaceId: workspace.id,
          computerId: computer.id,
          agentId: helper.id,
          channels: only!.purge.conversationIds.map((id) => ({ id, name: names.get(id)! })),
          reason: "visibility_private",
        }),
      );
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
  TIMEOUT_MS,
);
