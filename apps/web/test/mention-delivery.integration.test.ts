import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AGENT_MESSAGE_ACK_METHOD,
  decodeAgentMessageDelivery,
  encodeAgentMentionDeliveryTerminalError,
  encodeAgentMentionDeliveryTransition,
  encodeAgentMessageDeliveryAck,
  type AgentMessageDelivery,
  type MentionDeliveryEnvelope,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentControl } from "#src/server/agents/agent-control.server";
import {
  createAgentDeliveryAckMethod,
  createMentionDeliveryTerminalErrorMethod,
  createMentionDeliveryTransitionMethod,
  type CentrifugoRpcMethod,
} from "#src/server/centrifugo/rpc-handler.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  MentionDeliveryIssuer,
  MentionDeliveryReports,
} from "#src/server/conversations/mention-deliveries.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";

/**
 * Tracked @mention delivery on the cloud side: a channel message that @mentions an Agent records a
 * pending outcome for that Agent, and when the Agent has a running launch and session the push
 * carries an envelope naming them. The daemon's ACK that echoes the envelope settles it delivered;
 * its terminal errors settle it lost with a reason category, or unknown when the daemon's
 * instrument failed; an ACK that echoes no envelope for a delivery sent with one leaves it
 * unknown, which a later echoed ACK can still settle. An Agent that was not running is woken as
 * before, without an envelope. A person's Stop settles the Agent's pending mentions as not
 * launched. Deliveries that do not mention the Agent are never tracked. Drives the real services
 * against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };
const runtimeConfig = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `md-owner-${suffix}` } });
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug: `md-${suffix}`,
    name: "Mention delivery",
    userId: owner.id,
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: crypto.randomUUID() },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const agent = (name: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: owner.id,
        computerId: computer.id,
        runtimeConfig,
      },
    });
  /** Gives an Agent a running launch bound to a native session, as a session report does. */
  const launch = async (agentId: string, launchId: string, nativeSessionId: string) => {
    const session = await db.agentSession.create({
      data: {
        agentId,
        workspaceId: workspace.id,
        computerId: computer.id,
        provider: "pi",
        nativeSessionId,
        state: "resumable",
      },
    });
    await db.agent.update({
      where: { id: agentId },
      data: {
        currentSessionId: session.id,
        runtimeSession: {
          provider: "pi",
          computerId: computer.id,
          startRequestId: crypto.randomUUID(),
          daemonInstanceId: "daemon-1",
          launchId,
        },
      },
    });
  };
  const [bob, carol, dave] = await Promise.all([agent("bob"), agent("carol"), agent("dave")]);
  await launch(bob.id, "launch-bob-1", "native-bob-1");
  await launch(carol.id, "launch-carol-1", "native-carol-1");

  const published: AgentMessageDelivery[] = [];
  const publisher = {
    async publish(_channel: string, bytes: Uint8Array) {
      published.push(decodeAgentMessageDelivery(bytes));
    },
    async publishJson() {},
  } as unknown as CentrifugoServerApi;
  const channels = new PublicChannels(db, passThrough, publisher, undefined, {
    async messageAvailable() {},
    async memberChanged() {},
  });
  const team = await channels.create(workspace.id, owner.id, `team-${suffix}`);
  await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
    userIds: [],
    agentIds: [bob.id, carol.id, dave.id],
  });
  const conversations = new PrismaDirectConversationRepository(db);
  const repository = new PrismaMentionDeliveryRepository(db);
  const mentions = new MentionDeliveryReports(repository, publisher, conversations);
  const principal = { userId: owner.id, workspaceId: workspace.id, computerId: computer.id };
  const rpc = {
    ack: createAgentDeliveryAckMethod(mentions),
    transition: createMentionDeliveryTransitionMethod(mentions),
    terminal: createMentionDeliveryTerminalErrorMethod(mentions),
  };
  const call = async (method: CentrifugoRpcMethod, payload: Uint8Array) => {
    const result = await method(payload, { principal });
    expect(result).toBeInstanceOf(Uint8Array);
  };
  const send = async (body: string) => {
    published.length = 0;
    const message = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: team.id,
      requestId: crypto.randomUUID(),
      body,
    });
    return { id: message.id, deliveries: [...published] };
  };
  const row = (messageId: string, agentId: string) =>
    db.agentMessageDelivery.findUniqueOrThrow({
      where: { messageId_agentId: { messageId, agentId } },
      select: {
        deliveryId: true,
        receivedAt: true,
        mentionOutcome: true,
        mentionStage: true,
        mentionReasonCategory: true,
        mentionTerminalCode: true,
        mentionLaunchId: true,
        mentionSessionId: true,
        mentionSettledAt: true,
      },
    });
  const ack = (delivery: AgentMessageDelivery, mentionDelivery?: MentionDeliveryEnvelope) =>
    call(
      rpc.ack,
      encodeAgentMessageDeliveryAck({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        deliveryId: delivery.deliveryId,
        messageId: delivery.messageId,
        workspaceId: delivery.workspaceId,
        agentId: delivery.agentId,
        sequence: delivery.sequence,
        method: AGENT_MESSAGE_ACK_METHOD,
        ...(mentionDelivery ? { mentionDelivery } : {}),
      }),
    );
  const terminal = (
    delivery: AgentMessageDelivery,
    code: string,
    envelope?: MentionDeliveryEnvelope,
  ) =>
    call(
      rpc.terminal,
      encodeAgentMentionDeliveryTerminalError({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: delivery.workspaceId,
        agentId: delivery.agentId,
        deliveryId: delivery.deliveryId,
        code,
        mentionDelivery: envelope ?? delivery.mentionDelivery!,
      }),
    );
  const transition = (
    delivery: AgentMessageDelivery,
    stage: "daemon_received" | "daemon_pending",
    outcome: "accepted" | "coalesced",
  ) =>
    call(
      rpc.transition,
      encodeAgentMentionDeliveryTransition({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: delivery.workspaceId,
        agentId: delivery.agentId,
        deliveryId: delivery.deliveryId,
        stage,
        outcome,
        mentionDelivery: delivery.mentionDelivery!,
      }),
    );
  const pushTo = (deliveries: AgentMessageDelivery[], agentId: string) =>
    deliveries.find((delivery) => delivery.agentId === agentId)!;
  const control = new AgentControl(
    new PrismaAgentControlStore(db),
    { async publish() {} },
    { run: async (_id, work) => work() },
    { timeoutMs: 60_000 },
    undefined,
    undefined,
    undefined,
    new PrismaMentionDeliveryRepository(db),
  );
  const cleanup = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  };
  return {
    db,
    repository,
    workspace,
    computer,
    owner,
    bob,
    carol,
    dave,
    suffix,
    published,
    launch,
    send,
    row,
    ack,
    terminal,
    transition,
    pushTo,
    control,
    cleanup,
  };
}

test.skipIf(!connectionString)(
  "an @mention of a running Agent is pending with its envelope, and an echoed ACK delivers it",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} please review`);
      const bobPush = t.pushTo(sent.deliveries, t.bob.id);
      expect(bobPush.mentionDelivery).toEqual({
        messageId: sent.id,
        launchId: "launch-bob-1",
        sessionId: "native-bob-1",
        computerId: t.computer.id,
      });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-1",
        mentionSessionId: "native-bob-1",
        receivedAt: null,
        mentionSettledAt: null,
      });

      await t.transition(bobPush, "daemon_received", "accepted");
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionStage: "daemon_received",
      });

      await t.ack(bobPush, bobPush.mentionDelivery);
      const delivered = await t.row(sent.id, t.bob.id);
      expect(delivered).toMatchObject({
        mentionOutcome: "delivered",
        mentionReasonCategory: null,
      });
      expect(delivered.receivedAt).toBeInstanceOf(Date);
      expect(delivered.mentionSettledAt).toBeInstanceOf(Date);

      // Delivered is final: a late terminal error for the same envelope changes nothing.
      await t.terminal(bobPush, "DELIVERY_REJECTED");
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({ mentionOutcome: "delivered" });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a delivery that does not mention the Agent is never tracked",
  async () => {
    const t = await setup();
    try {
      // A top-level message without a mention reaches every unmuted Agent in the channel.
      const sent = await t.send("status update for the channel");
      expect(sent.deliveries.map((push) => push.agentId).sort()).toEqual(
        [t.bob.id, t.carol.id, t.dave.id].sort(),
      );
      for (const push of sent.deliveries) {
        expect(push.mentionDelivery).toBeUndefined();
        await t.ack(push);
      }
      for (const agentId of [t.bob.id, t.carol.id, t.dave.id]) {
        const row = await t.row(sent.id, agentId);
        expect(row).toMatchObject({
          mentionOutcome: null,
          mentionStage: null,
          mentionLaunchId: null,
          mentionSettledAt: null,
        });
        expect(row.receivedAt).toBeInstanceOf(Date);
      }
      // A person's Stop leaves them untracked.
      await t.control.stopMany({
        userId: t.owner.id,
        workspaceId: t.workspace.id,
        agentIds: [t.bob.id],
      });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({ mentionOutcome: null });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "each terminal code settles the mention with its outcome and reason category",
  async () => {
    const t = await setup();
    try {
      const cases = [
        ["QUOTA_LIMITED", "lost", "quota"],
        ["DELIVERY_REJECTED", "lost", "runtime_error"],
        ["UNSUPPORTED_DELIVERY_PATH", "lost", "runtime_error"],
        ["SOMETHING_NEW", "lost", "unclassified"],
        ["INSTRUMENT_FAILED", "unknown", null],
      ] as const;
      for (const [code, outcome, reason] of cases) {
        const sent = await t.send(`@carol-${t.suffix} ${code}`);
        await t.terminal(t.pushTo(sent.deliveries, t.carol.id), code);
        const settled = await t.row(sent.id, t.carol.id);
        expect(settled).toMatchObject({
          mentionOutcome: outcome,
          mentionReasonCategory: reason,
          mentionTerminalCode: code,
          receivedAt: null,
        });
        expect(settled.mentionSettledAt).toBeInstanceOf(Date);
      }

      // A terminal error for an envelope the row no longer carries is stale and changes nothing.
      const sent = await t.send(`@carol-${t.suffix} stale`);
      const push = t.pushTo(sent.deliveries, t.carol.id);
      await t.terminal(push, "QUOTA_LIMITED", { ...push.mentionDelivery!, launchId: "old-launch" });
      expect(await t.row(sent.id, t.carol.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionTerminalCode: null,
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "an ACK that echoes no envelope for a delivery sent with one records unknown, and a later echoed ACK still delivers",
  async () => {
    const t = await setup();
    try {
      // For example a ready replay, which re-sends the delivery without its envelope.
      const sent = await t.send(`@bob-${t.suffix} replayed without its envelope`);
      const push = t.pushTo(sent.deliveries, t.bob.id);
      await t.ack(push);
      const unknown = await t.row(sent.id, t.bob.id);
      expect(unknown).toMatchObject({ mentionOutcome: "unknown", mentionReasonCategory: null });
      expect(unknown.receivedAt).toBeInstanceOf(Date);

      await t.ack(push, push.mentionDelivery);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({ mentionOutcome: "delivered" });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "an @mention of an Agent that is not running is pending and wakes it without an envelope",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@dave-${t.suffix} wake up`);
      const push = t.pushTo(sent.deliveries, t.dave.id);
      expect(push.mentionsAgent).toBe(true);
      expect(push.mentionDelivery).toBeUndefined();
      expect(await t.row(sent.id, t.dave.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
      });
      // The daemon takes custody of the wake: the delivery is received, the mention stays pending.
      await t.ack(push);
      const row = await t.row(sent.id, t.dave.id);
      expect(row).toMatchObject({ mentionOutcome: "pending", mentionSettledAt: null });
      expect(row.receivedAt).toBeInstanceOf(Date);
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "an @mention of an Agent nothing may wake is settled not launched when it is sent",
  async () => {
    const t = await setup();
    try {
      // A person stopped Carol: her mention is not launched, and no envelope goes out.
      await t.db.agent.update({ where: { id: t.carol.id }, data: { stoppedAt: new Date() } });
      const stopped = await t.send(`@carol-${t.suffix} while stopped`);
      for (const push of stopped.deliveries) expect(push.mentionDelivery).toBeUndefined();
      const lost = await t.row(stopped.id, t.carol.id);
      expect(lost).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
        mentionLaunchId: null,
      });
      expect(lost.mentionSettledAt).toBeInstanceOf(Date);

      // Dave is on no Computer: nothing can wake him either.
      await t.db.agent.update({ where: { id: t.dave.id }, data: { computerId: null } });
      const unassigned = await t.send(`@dave-${t.suffix} anyone home`);
      expect(await t.row(unassigned.id, t.dave.id)).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "IDENTITY_UNKNOWN re-sends the mention once without an envelope, unless the Agent is stopped",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} are you there`);
      const push = t.pushTo(sent.deliveries, t.bob.id);
      t.published.length = 0;
      await t.terminal(push, "IDENTITY_UNKNOWN");
      expect(t.published).toHaveLength(1);
      expect(t.published[0]).toMatchObject({
        deliveryId: push.deliveryId,
        messageId: sent.id,
        agentId: t.bob.id,
        mentionsAgent: true,
      });
      expect(t.published[0]!.mentionDelivery).toBeUndefined();
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
        mentionSessionId: null,
        mentionTerminalCode: "IDENTITY_UNKNOWN",
      });

      // A stopped Agent cannot be woken, so the same error settles the mention not launched.
      const stopped = await t.send(`@carol-${t.suffix} are you there`);
      await t.db.agent.update({ where: { id: t.carol.id }, data: { stoppedAt: new Date() } });
      t.published.length = 0;
      await t.terminal(t.pushTo(stopped.deliveries, t.carol.id), "IDENTITY_UNKNOWN");
      expect(t.published).toHaveLength(0);
      expect(await t.row(stopped.id, t.carol.id)).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
        mentionTerminalCode: "IDENTITY_UNKNOWN",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "IDENTITY_DRIFT re-issues once for the Agent's current launch, then settles not launched",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} after a relaunch`);
      const first = t.pushTo(sent.deliveries, t.bob.id);
      await t.launch(t.bob.id, "launch-bob-2", "native-bob-2");
      t.published.length = 0;
      await t.terminal(first, "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(1);
      const reissued = t.published[0]!;
      expect(reissued.mentionDelivery).toEqual({
        messageId: sent.id,
        launchId: "launch-bob-2",
        sessionId: "native-bob-2",
        computerId: t.computer.id,
      });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-2",
        mentionTerminalCode: "IDENTITY_DRIFT",
      });

      // The re-issue drifted too: no second re-issue.
      t.published.length = 0;
      await t.terminal(reissued, "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(0);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
      });

      // Drift with no newer launch to re-issue for settles at once.
      const same = await t.send(`@carol-${t.suffix} no relaunch`);
      t.published.length = 0;
      await t.terminal(t.pushTo(same.deliveries, t.carol.id), "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(0);
      expect(await t.row(same.id, t.carol.id)).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a person's Stop settles the Agent's pending mentions as not launched",
  async () => {
    const t = await setup();
    try {
      const delivered = await t.send(`@bob-${t.suffix} first`);
      const push = t.pushTo(delivered.deliveries, t.bob.id);
      await t.ack(push, push.mentionDelivery);
      const pending = await t.send(`@bob-${t.suffix} second`);
      const other = await t.send(`@carol-${t.suffix} elsewhere`);

      await t.control.stopMany({
        userId: t.owner.id,
        workspaceId: t.workspace.id,
        agentIds: [t.bob.id],
      });

      const lost = await t.row(pending.id, t.bob.id);
      expect(lost).toMatchObject({ mentionOutcome: "lost", mentionReasonCategory: "not_launched" });
      expect(lost.mentionSettledAt).toBeInstanceOf(Date);
      expect(await t.row(delivered.id, t.bob.id)).toMatchObject({ mentionOutcome: "delivered" });
      expect(await t.row(other.id, t.carol.id)).toMatchObject({ mentionOutcome: "pending" });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a Stop that lands while a mention is being issued settles it not launched, never pending",
  async () => {
    const t = await setup();
    try {
      // An untracked delivery row to Bob, then issued as a mention while a person stops him
      // between the issuer's read and its writes.
      const sent = await t.send("status update for the channel");
      const row = await t.row(sent.id, t.bob.id);
      const racing = Object.assign(Object.create(t.repository), {
        async readIssuable(workspaceId: string, deliveryIds: readonly string[]) {
          const rows = await t.repository.readIssuable(workspaceId, deliveryIds);
          await t.control.stopMany({
            userId: t.owner.id,
            workspaceId: t.workspace.id,
            agentIds: [t.bob.id],
          });
          return rows;
        },
      }) as typeof t.repository;
      const envelopes = await new MentionDeliveryIssuer(racing).issue(t.workspace.id, [
        { deliveryId: row.deliveryId, agentId: t.bob.id, mentionsAgent: true },
      ]);
      expect(envelopes.size).toBe(0);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
        mentionLaunchId: null,
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "an echoed ACK that lands after a Stop settled the mention still records it delivered",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} just before the stop`);
      const push = t.pushTo(sent.deliveries, t.bob.id);
      await t.control.stopMany({
        userId: t.owner.id,
        workspaceId: t.workspace.id,
        agentIds: [t.bob.id],
      });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({ mentionOutcome: "lost" });
      await t.ack(push, push.mentionDelivery);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "delivered",
        mentionReasonCategory: null,
      });

      // Only a Stop's settlement gives way: a daemon's own terminal error stays final.
      const quota = await t.send(`@carol-${t.suffix} quota`);
      const carolPush = t.pushTo(quota.deliveries, t.carol.id);
      await t.terminal(carolPush, "QUOTA_LIMITED");
      await t.ack(carolPush, carolPush.mentionDelivery);
      expect(await t.row(quota.id, t.carol.id)).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "quota",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "IDENTITY_DRIFT after an ACK without the envelope still re-sends the delivery",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} acked without an envelope`);
      const first = t.pushTo(sent.deliveries, t.bob.id);
      await t.ack(first);
      await t.launch(t.bob.id, "launch-bob-2", "native-bob-2");
      t.published.length = 0;
      await t.terminal(first, "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(1);
      expect(t.published[0]).toMatchObject({
        deliveryId: first.deliveryId,
        mentionDelivery: { launchId: "launch-bob-2", sessionId: "native-bob-2" },
      });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-2",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a report whose envelope names another Computer is a drift: re-issued once for this one",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} issued elsewhere`);
      const push = t.pushTo(sent.deliveries, t.bob.id);
      const elsewhere = { ...push.mentionDelivery!, computerId: crypto.randomUUID() };
      t.published.length = 0;
      await t.terminal(push, "QUOTA_LIMITED", elsewhere);
      expect(t.published).toHaveLength(1);
      expect(t.published[0]!.mentionDelivery).toMatchObject({ computerId: t.computer.id });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionTerminalCode: "IDENTITY_DRIFT",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "issuing a mention again clears the stage and code its last envelope left",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} issued twice`);
      const push = t.pushTo(sent.deliveries, t.bob.id);
      await t.transition(push, "daemon_received", "accepted");
      await t.terminal(push, "IDENTITY_UNKNOWN");
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionTerminalCode: "IDENTITY_UNKNOWN",
      });
      await t.db.agentMessageDelivery.updateMany({
        where: { deliveryId: push.deliveryId },
        data: { mentionStage: "daemon_pending" },
      });
      const envelopes = await new MentionDeliveryIssuer(t.repository).issue(t.workspace.id, [
        { deliveryId: push.deliveryId, agentId: t.bob.id, mentionsAgent: true },
      ]);
      expect(envelopes.get(push.deliveryId)).toMatchObject({ launchId: "launch-bob-1" });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionStage: null,
        mentionTerminalCode: null,
        mentionLaunchId: "launch-bob-1",
      });
    } finally {
      await t.cleanup();
    }
  },
);
