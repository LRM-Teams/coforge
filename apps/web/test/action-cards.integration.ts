import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { ActionCards, ActionCardError } from "../src/server/conversations/action-cards.server";
import type { ActionCardErrorCode } from "../src/server/conversations/action-card-error.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { AppError, isAppError } from "../src/lib/app-error";

/**
 * Exercises `ActionCards.prepare` (see `apps/web/src/server/conversations/action-cards.server.ts`
 * and ADR 0027) against local PostgreSQL: handle resolution for all three action-card kinds,
 * target-grammar reuse from Agent `message send`, and the conflict/validation error shapes the
 * HTTP route (`apps/web/src/routes/api/agent/v1/actions/prepare.ts`) maps to 422/403/409.
 */

async function setup() {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `ac-alice-${suffix}` } });
  const bob = await db.user.create({ data: { username: `ac-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ac-${suffix}`,
      name: "Action Cards",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
      agents: {
        create: {
          name: `scout-${suffix}`,
          displayName: "Scout",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const existingAgent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `existing-${suffix}`,
      displayName: "Existing",
      ownerId: alice.id,
      runtimeConfig: {},
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: alice.id,
      machineId: crypto.randomUUID(),
      name: `box-${suffix}`,
      displayName: "Box",
    },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });

  const hub = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `hub-${suffix}`,
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const outsider = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `out-${suffix}`,
      members: { create: [{ userId: alice.id }] },
    },
  });

  const realtimeEvents: Array<{ conversationId: string; messageId: string; sequence: number }> = [];
  const actionCards = new ActionCards(db, new PrismaDirectConversationRepository(db), {
    async messageAvailable(event) {
      realtimeEvents.push(event);
    },
  });
  const principal = { workspaceId: workspace.id, agentId: agent.id };

  async function cleanup() {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }

  return {
    db,
    suffix,
    alice,
    bob,
    agent,
    existingAgent,
    computer,
    workspace,
    hub,
    outsider,
    actionCards,
    principal,
    realtimeEvents,
    cleanup,
  };
}

test("prepare persists channel:create with handles resolved to UUIDs and a readable summary", async () => {
  const ctx = await setup();
  try {
    const name = `design-${ctx.suffix}`;
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:create",
        name,
        initialHumans: [`@${ctx.alice.username}`, ctx.bob.username],
        initialAgents: [ctx.agent.id],
        draftHint: "onboarding needs a dedicated space",
      },
    });
    expect(result.metadata).toEqual({ kind: "action-card" });

    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.conversationId).toBe(ctx.hub.id);
    expect(message.body).toBe(
      `Action card: create channel #${name}\nonboarding needs a dedicated space`,
    );
    expect(message.sequence).toBeGreaterThan(0);

    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.kind).toBe("channel:create");
    expect(card.state).toBe("pending");
    expect(card.preparedByAgentId).toBe(ctx.agent.id);
    expect(card.payload).toEqual({
      type: "channel:create",
      name,
      visibility: "public",
      initialHumanIds: [ctx.alice.id, ctx.bob.id],
      initialAgentIds: [ctx.agent.id],
    });

    expect(ctx.realtimeEvents).toEqual([
      { conversationId: ctx.hub.id, messageId: result.messageId, sequence: message.sequence },
    ]);
  } finally {
    await ctx.cleanup();
  }
});

test("prepare persists agent:create resolving suggestedComputer by bare name", async () => {
  const ctx = await setup();
  try {
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "agent:create",
        name: `newbot-${ctx.suffix}`,
        description: "handles onboarding",
        suggestedComputer: ctx.computer.name,
      },
    });
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.kind).toBe("agent:create");
    expect(card.payload).toEqual({
      type: "agent:create",
      name: `newbot-${ctx.suffix}`,
      description: "handles onboarding",
      suggestedComputerId: ctx.computer.id,
    });
    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.body).toBe(`Action card: create agent newbot-${ctx.suffix}`);
  } finally {
    await ctx.cleanup();
  }
});

test("prepare persists channel:add_member resolving the channel by bare name and members by handle/UUID", async () => {
  const ctx = await setup();
  try {
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:add_member",
        channel: ctx.hub.channelName!,
        humans: [`@${ctx.bob.username}`],
        agents: [ctx.existingAgent.name],
      },
    });
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(card.payload).toEqual({
      type: "channel:add_member",
      channelId: ctx.hub.id,
      humanIds: [ctx.bob.id],
      agentIds: [ctx.existingAgent.id],
    });
    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.body).toBe(
      `Action card: add @${ctx.bob.username}, @${ctx.existingAgent.name} to #${ctx.hub.channelName}`,
    );
  } finally {
    await ctx.cleanup();
  }
});

async function expectActionCardError(
  promise: Promise<unknown>,
  expected: { code: ActionCardErrorCode; field?: string; message?: string },
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ActionCardError);
  const error = caught as ActionCardError;
  expect(error.code).toBe(expected.code);
  if (expected.field !== undefined) expect(error.field).toBe(expected.field);
  if (expected.message !== undefined) expect(error.message).toBe(expected.message);
}

test("prepare rejects an unknown handle with a field-scoped INVALID_HANDLE error", async () => {
  const ctx = await setup();
  try {
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: {
          type: "channel:add_member",
          channel: ctx.hub.channelName!,
          humans: ["@does-not-exist"],
        },
      }),
      { code: "INVALID_HANDLE", field: "action.humans[0]" },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare rejects a private channel:create as not-yet-supported", async () => {
  const ctx = await setup();
  try {
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "channel:create", name: `secret-${ctx.suffix}`, visibility: "private" },
      }),
      { code: "INVALID_ACTION", message: "private channels are not supported yet" },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare rejects channel:create for an existing name, including the reserved general channel", async () => {
  const ctx = await setup();
  try {
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "channel:create", name: ctx.hub.channelName! },
      }),
      { code: "CHANNEL_EXISTS" },
    );

    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "channel:create", name: "general" },
      }),
      { code: "CHANNEL_EXISTS" },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare rejects agent:create for an already-taken Agent name", async () => {
  const ctx = await setup();
  try {
    await expectActionCardError(
      ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.hub.channelName}`,
        action: { type: "agent:create", name: ctx.existingAgent.name },
      }),
      { code: "AGENT_EXISTS" },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("prepare denies an Agent that is not a member of the target channel", async () => {
  const ctx = await setup();
  try {
    let caught: unknown;
    try {
      await ctx.actionCards.prepare(ctx.principal, {
        target: `#${ctx.outsider.channelName}`,
        action: { type: "channel:create", name: `nope-${ctx.suffix}` },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe("ACCESS_DENIED");
  } finally {
    await ctx.cleanup();
  }
});

test("prepare posts into a thread when the target names a root message", async () => {
  const ctx = await setup();
  try {
    const root = await ctx.db.message.create({
      data: {
        conversationId: ctx.hub.id,
        workspaceId: ctx.workspace.id,
        senderMemberId: ctx.hub.members.find((member) => member.userId === ctx.alice.id)!.id,
        sequence: 1,
        body: "Let's plan this",
      },
    });
    const anchor = root.id.slice(0, 8);
    const result = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}:${anchor}`,
      action: { type: "channel:create", name: `planned-${ctx.suffix}` },
    });
    const message = await ctx.db.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(message.threadRootId).toBe(root.id);
    expect(message.conversationId).toBe(ctx.hub.id);
  } finally {
    await ctx.cleanup();
  }
});
