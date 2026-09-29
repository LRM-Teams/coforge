import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AGENT_MESSAGE_ACK_METHOD,
  decodeAgentMessageDelivery,
  decodeAgentStartIntent,
  encodeAgentMentionDeliveryTerminalError,
  encodeAgentMentionDeliveryTransition,
  encodeAgentMessageDeliveryAck,
  encodeAgentSessionReport,
  type AgentMessageDelivery,
  type AgentStartIntent,
  type MentionDeliveryEnvelope,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { AgentSessionReceiver } from "#src/server/agents/agent-session.server";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";
import { AgentSessions } from "#src/server/agents/agent-sessions.server";
import {
  createAgentDeliveryAckMethod,
  createAgentSessionMethod,
  createMentionDeliveryTerminalErrorMethod,
  createMentionDeliveryTransitionMethod,
  type CentrifugoRpcMethod,
} from "#src/server/centrifugo/rpc-handler.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import {
  MentionDeliveryIssuer,
  MentionDeliveryLookup,
  MentionDeliveryReports,
  type SenderMentionDeliveries,
} from "#src/server/conversations/mention-deliveries.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaAgentSessionRepository } from "#src/server/db/repositories/agent-session.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
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
 * launched. A pending mention that went out without an envelope, or with one for a launch that is
 * no longer the Agent's, is issued again for its current launch and session when a launch reports
 * its session and when its daemon comes back ready. Deliveries that do not mention the Agent are
 * never tracked. Drives the real services against local PostgreSQL.
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
    mentions,
  );
  /** The cloud's side of a real session report: a start's fence, then the accepted report. */
  const sessions = new AgentSessions(
    new PrismaAgentSessionRepository(db),
    async () => "daemon-1",
    mentions,
  );
  const scope = (agentId: string) => ({
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId,
  });
  /** A launch's session was accepted as the Agent's current one. */
  const sessionAccepted = (agentId: string) => mentions.resendForCurrentSession(scope(agentId));
  /** The daemon came back ready with these Agents running. */
  const ready = (running: string[], reports = mentions) =>
    new WorkspaceAgentRecovery(
      new PrismaAgentRepository(db),
      conversations,
      publisher,
      { run: async (_id, work) => work() },
      reports,
    ).recoverWorkspace(workspace.id, computer.id, running);
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
    principal,
    publisher,
    conversations,
    mentions,
    sessions,
    scope,
    sessionAccepted,
    ready,
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
  "IDENTITY_DRIFT issues the mention for a newer launch the cloud knows, once per launch, and otherwise keeps it pending for the next session",
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

      // The re-issue drifted too, and the cloud knows nothing newer: it waits, pending and
      // without an envelope, for the next session.
      t.published.length = 0;
      await t.terminal(reissued, "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(0);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
        mentionTerminalCode: "IDENTITY_DRIFT",
      });

      // The next launch's session issues it, and the drift it answered no longer counts.
      await t.launch(t.bob.id, "launch-bob-3", "native-bob-3");
      await t.sessionAccepted(t.bob.id);
      expect(t.published).toHaveLength(1);
      const third = t.published[0]!;
      expect(third.mentionDelivery).toMatchObject({ launchId: "launch-bob-3" });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-3",
        mentionTerminalCode: null,
      });

      // A second relaunch the cloud already knows is issued for at once.
      await t.launch(t.bob.id, "launch-bob-4", "native-bob-4");
      t.published.length = 0;
      await t.terminal(third, "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(1);
      expect(t.published[0]!.mentionDelivery).toMatchObject({ launchId: "launch-bob-4" });
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-4",
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
  "a Stop that lands while a mention is being issued waits for it, then settles it not launched",
  async () => {
    const t = await setup();
    try {
      // An untracked delivery row to Bob, then issued as a mention while a person stops him from
      // inside the issuing transaction: the Stop waits for it, and settles what it wrote.
      const sent = await t.send("status update for the channel");
      const row = await t.row(sent.id, t.bob.id);
      let stopping: Promise<unknown> = Promise.resolve();
      const racing = Object.assign(Object.create(t.repository), {
        issue: (
          ...[workspaceId, deliveryIds, decide, now]: Parameters<typeof t.repository.issue>
        ) =>
          t.repository.issue(
            workspaceId,
            deliveryIds,
            (mentions) => {
              stopping = t.control.stopMany({
                userId: t.owner.id,
                workspaceId: t.workspace.id,
                agentIds: [t.bob.id],
              });
              return decide(mentions);
            },
            now,
          ),
      }) as typeof t.repository;
      const envelopes = await new MentionDeliveryIssuer(racing).issue(t.workspace.id, [
        { deliveryId: row.deliveryId, agentId: t.bob.id, mentionsAgent: true },
      ]);
      expect(envelopes.get(row.deliveryId)).toMatchObject({ launchId: "launch-bob-1" });
      await stopping;
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a session report that lands while a mention is being issued waits for it, then issues the wake it wrote",
  async () => {
    const t = await setup();
    try {
      const startRequestId = crypto.randomUUID();
      await t.sessions.prepare({
        protocolMajor: 1,
        requestId: startRequestId,
        workspaceId: t.workspace.id,
        computerId: t.computer.id,
        agentId: t.dave.id,
        provider: "pi",
        model: "",
        reasoning: "",
        launchId: "launch-dave-1",
      });
      const sent = await t.send("status update for the channel");
      const row = await t.row(sent.id, t.dave.id);
      let accepting: Promise<unknown> = Promise.resolve();
      const racing = Object.assign(Object.create(t.repository), {
        issue: (
          ...[workspaceId, deliveryIds, decide, now]: Parameters<typeof t.repository.issue>
        ) =>
          t.repository.issue(
            workspaceId,
            deliveryIds,
            (mentions) => {
              accepting = t.sessions.accept({
                protocolMajor: 1,
                requestId: crypto.randomUUID(),
                workspaceId: t.workspace.id,
                computerId: t.computer.id,
                agentId: t.dave.id,
                provider: "pi",
                sessionId: "native-dave-1",
                startRequestId,
                daemonInstanceId: "daemon-1",
                launchId: "launch-dave-1",
              });
              return decide(mentions);
            },
            now,
          ),
      }) as typeof t.repository;
      t.published.length = 0;
      const envelopes = await new MentionDeliveryIssuer(racing).issue(t.workspace.id, [
        { deliveryId: row.deliveryId, agentId: t.dave.id, mentionsAgent: true },
      ]);
      expect(envelopes.size).toBe(0);
      await accepting;
      expect(t.published).toEqual([
        expect.objectContaining({
          deliveryId: row.deliveryId,
          mentionDelivery: expect.objectContaining({
            launchId: "launch-dave-1",
            sessionId: "native-dave-1",
          }),
        }),
      ]);
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

test.skipIf(!connectionString)(
  "a woken Agent's session report issues its pending mention for the new launch, and an echoed ACK delivers it",
  async () => {
    const t = await setup();
    try {
      // Dave is being started: his launch is fenced, his session not yet reported.
      const startRequestId = crypto.randomUUID();
      await t.sessions.prepare({
        protocolMajor: 1,
        requestId: startRequestId,
        workspaceId: t.workspace.id,
        computerId: t.computer.id,
        agentId: t.dave.id,
        provider: "pi",
        model: "",
        reasoning: "",
        launchId: "launch-dave-1",
      });
      const sent = await t.send(`@dave-${t.suffix} wake up`);
      const wake = t.pushTo(sent.deliveries, t.dave.id);
      expect(wake.mentionDelivery).toBeUndefined();
      await t.ack(wake);
      expect(await t.row(sent.id, t.dave.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
      });

      const report = createAgentSessionMethod(t.sessions);
      const payload = encodeAgentSessionReport({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: t.workspace.id,
        computerId: t.computer.id,
        agentId: t.dave.id,
        provider: "pi",
        sessionId: "native-dave-1",
        startRequestId,
        daemonInstanceId: "daemon-1",
        launchId: "launch-dave-1",
      });
      t.published.length = 0;
      expect(await report(payload, { principal: t.principal })).toBeInstanceOf(Uint8Array);
      expect(t.published).toHaveLength(1);
      const reissued = t.published[0]!;
      expect(reissued).toMatchObject({
        deliveryId: wake.deliveryId,
        mentionsAgent: true,
        mentionDelivery: {
          messageId: sent.id,
          launchId: "launch-dave-1",
          sessionId: "native-dave-1",
          computerId: t.computer.id,
        },
      });
      expect(await t.row(sent.id, t.dave.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-dave-1",
        mentionSessionId: "native-dave-1",
      });

      // The same report again finds nothing left to issue.
      t.published.length = 0;
      expect(await report(payload, { principal: t.principal })).toBeInstanceOf(Uint8Array);
      expect(t.published).toHaveLength(0);

      await t.ack(reissued, reissued.mentionDelivery);
      expect(await t.row(sent.id, t.dave.id)).toMatchObject({ mentionOutcome: "delivered" });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a controlled launch's sequenced session snapshot, or its started result, issues the pending mention for it",
  async () => {
    const t = await setup();
    try {
      const store = new PrismaAgentControlStore(t.db);
      const starts: AgentStartIntent[] = [];
      // The started result does not wait for its re-send; the test awaits the one it began.
      let resending: Promise<void> = Promise.resolve();
      const control = new AgentControl(
        store,
        { publish: async (_channel, bytes) => void starts.push(decodeAgentStartIntent(bytes)) },
        { run: async (_id, work) => work() },
        { timeoutMs: 60_000 },
        t.sessions,
        undefined,
        undefined,
        {
          settleStopped: (input) => t.mentions.settleStopped(input),
          resendForCurrentSession: (scope) =>
            (resending = t.mentions.resendForCurrentSession(scope)),
        },
      );
      const start = async (agentId: string) => {
        await control.publishStart(
          {
            protocolMajor: 1,
            requestId: crypto.randomUUID(),
            workspaceId: t.workspace.id,
            computerId: t.computer.id,
            agentId,
            provider: "pi",
            model: "",
            reasoning: "",
          },
          t.owner.id,
        );
        return starts.at(-1)!;
      };

      // Dave's launch reports its session as a sequenced snapshot.
      const daveStart = await start(t.dave.id);
      const woken = await t.send(`@dave-${t.suffix} wake up`);
      await t.ack(t.pushTo(woken.deliveries, t.dave.id));
      const snapshot = createAgentSessionMethod(
        t.sessions,
        new AgentSessionReceiver(store, async () => "daemon-1", t.mentions),
      );
      t.published.length = 0;
      expect(
        await snapshot(
          encodeAgentSessionReport({
            protocolMajor: 1,
            requestId: crypto.randomUUID(),
            workspaceId: t.workspace.id,
            computerId: t.computer.id,
            agentId: t.dave.id,
            provider: "pi",
            sessionId: "native-dave-1",
            startRequestId: daveStart.requestId,
            daemonInstanceId: "daemon-1",
            launchId: daveStart.launchId!,
            controlEpoch: daveStart.controlEpoch!,
            sequence: 1,
            sessionState: "resumable",
          }),
          { principal: t.principal },
        ),
      ).toBeInstanceOf(Uint8Array);
      expect(t.published).toEqual([
        expect.objectContaining({
          messageId: woken.id,
          mentionDelivery: expect.objectContaining({
            launchId: daveStart.launchId,
            sessionId: "native-dave-1",
          }),
        }),
      ]);

      // Carol's mention went out for her old launch; her restart binds its session in the
      // started result.
      const stale = await t.send(`@carol-${t.suffix} before the restart`);
      const carolStart = await start(t.carol.id);
      t.published.length = 0;
      await control.result(t.principal, {
        protocolMajor: 1,
        requestId: carolStart.requestId,
        workspaceId: t.workspace.id,
        computerId: t.computer.id,
        agentId: t.carol.id,
        provider: "pi",
        epoch: carolStart.controlEpoch!,
        phase: "started",
        launchId: carolStart.launchId,
        sequence: 1,
        identity: { sessionId: "native-carol-2", state: "resumable" },
      });
      await resending;
      expect(t.published).toEqual([
        expect.objectContaining({
          messageId: stale.id,
          mentionDelivery: expect.objectContaining({
            launchId: carolStart.launchId,
            sessionId: "native-carol-2",
          }),
        }),
      ]);
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "daemon ready re-sends a running Agent's pending mentions with an envelope for its current launch",
  async () => {
    const t = await setup();
    try {
      const before = await t.send(`@bob-${t.suffix} before the relaunch`);
      const status = await t.send("status update for the channel");
      await t.launch(t.bob.id, "launch-bob-2", "native-bob-2");
      const after = await t.send(`@bob-${t.suffix} after the relaunch`);
      const woken = await t.send(`@dave-${t.suffix} wake up`);
      await t.ack(t.pushTo(woken.deliveries, t.dave.id));
      await t.launch(t.dave.id, "launch-dave-1", "native-dave-1");

      t.published.length = 0;
      await t.ready([t.bob.id, t.carol.id, t.dave.id]);

      const pushed = (agentId: string, messageId: string) =>
        t.published.filter((push) => push.agentId === agentId && push.messageId === messageId);
      expect(new Set(t.published.map((push) => push.deliveryId)).size).toBe(t.published.length);
      const bobBefore = pushed(t.bob.id, before.id);
      expect(bobBefore).toHaveLength(1);
      expect(bobBefore[0]!.mentionDelivery).toEqual({
        messageId: before.id,
        launchId: "launch-bob-2",
        sessionId: "native-bob-2",
        computerId: t.computer.id,
      });
      expect(pushed(t.bob.id, status.id)).toEqual([
        expect.not.objectContaining({ mentionDelivery: expect.anything() }),
      ]);
      // Issued for the current launch when sent: its envelope goes out again with it.
      expect(pushed(t.bob.id, after.id)).toEqual([
        expect.objectContaining({
          mentionDelivery: expect.objectContaining({
            launchId: "launch-bob-2",
            sessionId: "native-bob-2",
          }),
        }),
      ]);
      // Received as a wake, so only its re-issue sends it again.
      expect(pushed(t.dave.id, woken.id)).toEqual([
        expect.objectContaining({
          mentionsAgent: true,
          mentionDelivery: expect.objectContaining({
            launchId: "launch-dave-1",
            sessionId: "native-dave-1",
          }),
        }),
      ]);

      await t.ack(bobBefore[0]!, bobBefore[0]!.mentionDelivery);
      expect(await t.row(before.id, t.bob.id)).toMatchObject({ mentionOutcome: "delivered" });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "at daemon ready, a running Agent with no session yet gets a stale mention as a wake, and a plain ACK leaves it pending",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} before the session`);
      await t.db.agent.update({ where: { id: t.bob.id }, data: { currentSessionId: null } });

      t.published.length = 0;
      await t.ready([t.bob.id, t.carol.id, t.dave.id]);

      const push = t.published.find(
        (delivery) => delivery.agentId === t.bob.id && delivery.messageId === sent.id,
      )!;
      expect(push.mentionDelivery).toBeUndefined();
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
      });
      await t.ack(push);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({ mentionOutcome: "pending" });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "at daemon ready, a mention a concurrent drift answer took is left to it, not sent without its envelope",
  async () => {
    const t = await setup();
    try {
      const sent = await t.send(`@bob-${t.suffix} taken`);
      await t.launch(t.bob.id, "launch-bob-2", "native-bob-2");
      // Between ready's read and its re-issue, a drift answer issues the mention for another launch.
      const racing = Object.assign(Object.create(t.repository), {
        async readPending(workspaceId: string, agentId: string) {
          const read = await t.repository.readPending(workspaceId, agentId);
          await t.db.agentMessageDelivery.updateMany({
            where: { messageId: sent.id, agentId: t.bob.id },
            data: { mentionLaunchId: "launch-bob-9", mentionSessionId: "native-bob-9" },
          });
          return read;
        },
      }) as typeof t.repository;

      t.published.length = 0;
      await t.ready(
        [t.bob.id, t.carol.id, t.dave.id],
        new MentionDeliveryReports(racing, t.publisher, t.conversations),
      );
      expect(
        t.published.filter((push) => push.agentId === t.bob.id && push.messageId === sent.id),
      ).toEqual([]);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-9",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a re-issued mention that is not sent keeps no envelope, so the next session issues it again",
  async () => {
    const t = await setup();
    try {
      const failed = await t.send(`@bob-${t.suffix} publish fails`);
      await t.launch(t.bob.id, "launch-bob-2", "native-bob-2");
      const unavailable = {
        async publish() {
          throw new Error("centrifugo unavailable");
        },
      } as unknown as CentrifugoServerApi;
      await new MentionDeliveryReports(
        t.repository,
        unavailable,
        t.conversations,
      ).resendForCurrentSession(t.scope(t.bob.id));
      expect(await t.row(failed.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
      });
      t.published.length = 0;
      await t.sessionAccepted(t.bob.id);
      expect(t.published).toEqual([
        expect.objectContaining({
          messageId: failed.id,
          mentionDelivery: expect.objectContaining({ launchId: "launch-bob-2" }),
        }),
      ]);

      // A mention whose delivery is not read back (Carol left the channel) is not sent either.
      const left = await t.send(`@carol-${t.suffix} then she leaves`);
      await t.launch(t.carol.id, "launch-carol-2", "native-carol-2");
      await t.db.conversationMember.updateMany({
        where: { agentId: t.carol.id },
        data: { leftAt: new Date() },
      });
      t.published.length = 0;
      await t.sessionAccepted(t.carol.id);
      expect(t.published).toHaveLength(0);
      expect(await t.row(left.id, t.carol.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a drift and the new launch's session send the mention once and leave the same outcome, whichever comes first",
  async () => {
    const t = await setup();
    try {
      // Drift first, the newer launch already known.
      const known = await t.send(`@bob-${t.suffix} drift first, launch known`);
      await t.launch(t.bob.id, "launch-bob-2", "native-bob-2");
      t.published.length = 0;
      await t.terminal(t.pushTo(known.deliveries, t.bob.id), "IDENTITY_DRIFT");
      await t.sessionAccepted(t.bob.id);
      expect(t.published).toHaveLength(1);
      expect(await t.row(known.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-2",
      });

      // Session first: the drift names an envelope already replaced.
      const reported = await t.send(`@carol-${t.suffix} session first`);
      await t.launch(t.carol.id, "launch-carol-2", "native-carol-2");
      t.published.length = 0;
      await t.sessionAccepted(t.carol.id);
      await t.terminal(t.pushTo(reported.deliveries, t.carol.id), "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(1);
      expect(await t.row(reported.id, t.carol.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-carol-2",
      });

      // Drift first, the newer launch not yet known: it waits for the session.
      const unknown = await t.send(`@carol-${t.suffix} drift first, launch unknown`);
      t.published.length = 0;
      await t.terminal(t.pushTo(unknown.deliveries, t.carol.id), "IDENTITY_DRIFT");
      expect(t.published).toHaveLength(0);
      await t.launch(t.carol.id, "launch-carol-3", "native-carol-3");
      await t.sessionAccepted(t.carol.id);
      expect(t.published.filter((push) => push.messageId === unknown.id)).toEqual([
        expect.objectContaining({
          mentionDelivery: expect.objectContaining({ launchId: "launch-carol-3" }),
        }),
      ]);
      expect(await t.row(unknown.id, t.carol.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-carol-3",
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "the Agent that sent a message reads each @mentioned Agent's outcome; no one else can",
  async () => {
    const t = await setup();
    try {
      const published: AgentMessageDelivery[] = [];
      const publisher = {
        async publish(_channel: string, bytes: Uint8Array) {
          published.push(decodeAgentMessageDelivery(bytes));
        },
      } as unknown as CentrifugoServerApi;
      const sender = new SendDirectMessage(
        new PrismaDirectConversationRepository(t.db),
        passThrough,
        publisher,
        undefined,
        undefined,
        new MentionDeliveryIssuer(t.repository),
      );
      const sent = await sender.executeFromAgent({
        requestId: crypto.randomUUID(),
        workspaceId: t.workspace.id,
        agentId: t.bob.id,
        target: `#team-${t.suffix}`,
        body: `@carol-${t.suffix} @dave-${t.suffix} can you both take a look`,
      });
      // Carol is running and her runtime refuses the mention for quota; Dave is woken without an
      // envelope, so his mention stays pending.
      await t.terminal(t.pushTo(published, t.carol.id), "QUOTA_LIMITED");

      const lookup = new MentionDeliveryLookup(t.repository);
      const scope = (agentId: string) => ({ workspaceId: t.workspace.id, agentId });
      const found = {
        state: "found",
        messageId: sent.id,
        deliveries: [
          { targetHandle: `@carol-${t.suffix}`, outcome: "lost", reasonCategory: "quota" },
          { targetHandle: `@dave-${t.suffix}`, outcome: "pending" },
        ],
      } satisfies SenderMentionDeliveries;
      expect(await lookup.forSender(scope(t.bob.id), sent.id)).toEqual(found);
      // The eight-hex prefix `message read` shows names the same message.
      expect(await lookup.forSender(scope(t.bob.id), sent.id.slice(0, 8))).toEqual(found);

      // Another Agent, even one the message mentioned, cannot read it: not found.
      const notFound = { state: "not_found" } satisfies SenderMentionDeliveries;
      expect(await lookup.forSender(scope(t.carol.id), sent.id)).toEqual(notFound);
      expect(await lookup.forSender(scope(t.carol.id), sent.id.slice(0, 8))).toEqual(notFound);
      // Nor can Bob read a message a person sent, or an id that names no message.
      const byPerson = await t.send(`@bob-${t.suffix} over to you`);
      expect(await lookup.forSender(scope(t.bob.id), byPerson.id)).toEqual(notFound);
      expect(await lookup.forSender(scope(t.bob.id), crypto.randomUUID())).toEqual(notFound);
      expect(await lookup.forSender(scope(t.bob.id), "not-a-message-id")).toEqual(notFound);
      expect(await lookup.forSender(scope(t.bob.id), sent.id.slice(0, 6))).toEqual(notFound);

      // A deleted Agent whose name was taken again still reads as the handle Bob wrote.
      await t.db.agent.update({
        where: { id: t.dave.id },
        data: { deletedAt: new Date(), name: `dave-${t.suffix}-deleted-000000000000` },
      });
      expect(await lookup.forSender(scope(t.bob.id), sent.id)).toEqual({
        ...found,
        deliveries: [
          found.deliveries[0],
          { targetHandle: `@dave-${t.suffix}`, targetDeleted: true, outcome: "pending" },
        ],
      });

      // A message of Bob's that tracked no mention answers an empty list.
      const plain = await sender.executeFromAgent({
        requestId: crypto.randomUUID(),
        workspaceId: t.workspace.id,
        agentId: t.bob.id,
        target: `#team-${t.suffix}`,
        body: "status update, nobody in particular",
      });
      expect(await lookup.forSender(scope(t.bob.id), plain.id)).toEqual({
        state: "found",
        messageId: plain.id,
        deliveries: [],
      });
    } finally {
      await t.cleanup();
    }
  },
);
