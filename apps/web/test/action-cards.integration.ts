import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { ActionCards, ActionCardError } from "../src/server/conversations/action-cards.server";
import type { ActionCardErrorCode } from "../src/server/conversations/action-card-error.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { AppError, isAppError, type AppErrorCode } from "../src/lib/app-error";

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
  const dave = await db.user.create({ data: { username: `ac-dave-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ac-${suffix}`,
      name: "Action Cards",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id, role: "member" },
          { userId: dave.id, role: "admin" },
        ],
      },
      agents: {
        create: [
          {
            name: `scout-${suffix}`,
            displayName: "Scout",
            ownerId: alice.id,
            runtimeConfig: {},
          },
          {
            name: `helper-${suffix}`,
            displayName: "Helper",
            ownerId: bob.id,
            runtimeConfig: {},
          },
        ],
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents.find((a) => a.name === `scout-${suffix}`)!;
  const bobsAgent = workspace.agents.find((a) => a.name === `helper-${suffix}`)!;
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
      members: {
        create: [{ userId: alice.id }, { agentId: agent.id }, { agentId: bobsAgent.id }],
      },
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
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, dave.id] } } });
    await db.$disconnect();
  }

  return {
    db,
    suffix,
    alice,
    bob,
    dave,
    agent,
    bobsAgent,
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

    // One publication, carrying the Workspace the browser scopes the signal to. The event is
    // additive (ADR 0046): it may grow further fields, so pin the meaningful ones and the count.
    expect(ctx.realtimeEvents).toEqual([
      expect.objectContaining({
        conversationId: ctx.hub.id,
        messageId: result.messageId,
        sequence: message.sequence,
        workspaceId: ctx.hub.workspaceId,
      }),
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

/**
 * Commit/cancel (ADR 0027 "Commit and cancel"): a human executes the real operation under their
 * own identity, then the card is marked `executed`/`cancelled`. Reuses `setup()`'s fixture: alice
 * is Workspace owner and Scout's (`ctx.agent`) owner, bob is a plain member and Helper's
 * (`ctx.bobsAgent`) owner, dave is Workspace admin.
 */

async function expectAppErrorCode(promise: Promise<unknown>, code: AppErrorCode) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  expect((caught as AppError).code).toBe(code);
}

test("commit channel:create executes PublicChannels.create + addMembers and marks the card executed", async () => {
  const ctx = await setup();
  try {
    const name = `commit-create-${ctx.suffix}`;
    const description = "Engineering discussion";
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name, description, initialHumans: [ctx.bob.username] },
    });

    const result = await ctx.actionCards.commitChannelCreate(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      { messageId: prepared.messageId, name, memberUserIds: [ctx.bob.id], memberAgentIds: [] },
    );

    const created = await ctx.db.conversation.findUniqueOrThrow({
      where: { id: result.channelId },
      include: { members: true },
    });
    expect(created.channelName).toBe(name);
    // ADR 0031: the Agent-proposed description rides along from the card's own resolved payload
    // and is now persisted on the created Conversation (ADR 0024 added the column; ADR 0027's
    // "known gap" is closed).
    expect(created.description).toBe(description);
    expect(created.members.some((member) => member.userId === ctx.bob.id)).toBe(true);

    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(card.state).toBe("executed");
    expect(card.committedByUserId).toBe(ctx.alice.id);
    expect(card.committedAt).not.toBeNull();
    expect(card.result).toEqual({ channelId: result.channelId });

    // A second commit fails: the operation's own name-uniqueness rule fires first.
    await expectAppErrorCode(
      ctx.actionCards.commitChannelCreate(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
        { messageId: prepared.messageId, name, memberUserIds: [], memberAgentIds: [] },
      ),
      "CONFLICT",
    );
  } finally {
    await ctx.cleanup();
  }
});

test("commit channel:add_member requires the actor to already be a channel member", async () => {
  const ctx = await setup();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:add_member",
        channel: ctx.hub.channelName!,
        humans: [ctx.bob.username],
      },
    });

    // bob is not a member of #hub yet: ACCESS_DENIED, card stays pending.
    await expectAppErrorCode(
      ctx.actionCards.commitChannelAddMember(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
        {
          messageId: prepared.messageId,
          channelId: ctx.hub.id,
          userIds: [ctx.bob.id],
          agentIds: [],
        },
      ),
      "ACCESS_DENIED",
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: prepared.messageId } }))
        .state,
    ).toBe("pending");

    // alice is a member of #hub: succeeds and marks the card.
    const result = await ctx.actionCards.commitChannelAddMember(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      { messageId: prepared.messageId, channelId: ctx.hub.id, userIds: [ctx.bob.id], agentIds: [] },
    );
    expect(result).toEqual({ channelId: ctx.hub.id, userIds: [ctx.bob.id], agentIds: [] });
    const member = await ctx.db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: ctx.hub.id, userId: ctx.bob.id } },
    });
    expect(member).not.toBeNull();
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(card.state).toBe("executed");
    expect(card.committedByUserId).toBe(ctx.alice.id);
  } finally {
    await ctx.cleanup();
  }
});

test("agent:create guard/mark: pending precheck, workspace scoping, and marking executed", async () => {
  const ctx = await setup();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "agent:create",
        name: `newagent-${ctx.suffix}`,
        requiredComputer: ctx.computer.name,
      },
    });

    // Guard passes while pending, the viewer can read the conversation, and the required Computer
    // is the one being used.
    await ctx.actionCards.assertAgentCreateCommittable(
      ctx.workspace.id,
      ctx.alice.id,
      prepared.messageId,
      ctx.computer.id,
    );

    // `requiredComputer` is a placement contract: another Computer is rejected server-side.
    await expectAppErrorCode(
      ctx.actionCards.assertAgentCreateCommittable(
        ctx.workspace.id,
        ctx.alice.id,
        prepared.messageId,
        crypto.randomUUID(),
      ),
      "INVALID_INPUT",
    );

    // A viewer who cannot read the conversation (not a Workspace member of this Workspace) is
    // rejected before any Agent would be created.
    const stranger = await ctx.db.user.create({ data: { username: `ac-stranger-${ctx.suffix}` } });
    try {
      await expectAppErrorCode(
        ctx.actionCards.assertAgentCreateCommittable(
          ctx.workspace.id,
          stranger.id,
          prepared.messageId,
          ctx.computer.id,
        ),
        "ACCESS_DENIED",
      );
    } finally {
      await ctx.db.user.delete({ where: { id: stranger.id } });
    }

    // `ManageAgents.create`'s own authority gate (`assertCanCreateAgents`, owner/admin only) is
    // covered by `manage-agents.test.ts`; here we only own the guard-before/mark-after seam
    // `agents.functions.ts#createAgent` calls around it (see ADR 0027 "Commit and cancel").
    const created = await ctx.db.agent.create({
      data: {
        workspaceId: ctx.workspace.id,
        name: `newagent-${ctx.suffix}`,
        displayName: `newagent-${ctx.suffix}`,
        ownerId: ctx.alice.id,
        runtimeConfig: {},
      },
    });
    await ctx.actionCards.completeAgentCreate(
      ctx.workspace.id,
      ctx.alice.id,
      prepared.messageId,
      created.id,
    );
    const card = await ctx.db.actionCard.findUniqueOrThrow({
      where: { messageId: prepared.messageId },
    });
    expect(card.state).toBe("executed");
    expect(card.committedByUserId).toBe(ctx.alice.id);
    expect(card.result).toEqual({ agentId: created.id });

    // Once executed, the guard rejects a second attempt before any second Agent is created.
    await expectAppErrorCode(
      ctx.actionCards.assertAgentCreateCommittable(
        ctx.workspace.id,
        ctx.alice.id,
        prepared.messageId,
        ctx.computer.id,
      ),
      "CONFLICT",
    );
  } finally {
    await ctx.cleanup();
  }
});

test("cancel: the preparing Agent's owner and a Workspace admin may cancel; another member may not", async () => {
  const ctx = await setup();
  try {
    // Helper is owned by bob, a plain member: proves the Agent.ownerId path independent of role.
    const helperPrincipal = { workspaceId: ctx.workspace.id, agentId: ctx.bobsAgent.id };
    const byOwner = await ctx.actionCards.prepare(helperPrincipal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `owner-cancel-${ctx.suffix}` },
    });
    await ctx.actionCards.cancel(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
      byOwner.messageId,
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: byOwner.messageId } }))
        .state,
    ).toBe("cancelled");

    // Scout is owned by alice; dave (admin, not the owner) may still cancel.
    const byAdmin = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `admin-cancel-${ctx.suffix}` },
    });
    await ctx.actionCards.cancel(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.dave.id },
      byAdmin.messageId,
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: byAdmin.messageId } }))
        .state,
    ).toBe("cancelled");

    // Another plain member (bob), neither the owner nor an admin, is denied.
    const byOther = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `denied-cancel-${ctx.suffix}` },
    });
    await expectAppErrorCode(
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.bob.id },
        byOther.messageId,
      ),
      "ACCESS_DENIED",
    );
    expect(
      (await ctx.db.actionCard.findUniqueOrThrow({ where: { messageId: byOther.messageId } }))
        .state,
    ).toBe("pending");

    // A second cancel on an already-cancelled card is CONFLICT.
    await expectAppErrorCode(
      ctx.actionCards.cancel(
        { workspaceId: ctx.workspace.id, actorUserId: ctx.dave.id },
        byAdmin.messageId,
      ),
      "CONFLICT",
    );
  } finally {
    await ctx.cleanup();
  }
});

test("viewsFor resolves names, reports per-viewer canCommit/canCancel, and exposes the committer", async () => {
  const ctx = await setup();
  try {
    const createCard = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `views-${ctx.suffix}`, initialHumans: [ctx.bob.id] },
    });
    const addMemberCard = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: {
        type: "channel:add_member",
        channel: ctx.hub.channelName!,
        humans: [ctx.bob.username],
      },
    });
    const agentCard = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "agent:create", name: `viewsagent-${ctx.suffix}` },
    });
    const ids = [createCard.messageId, addMemberCard.messageId, agentCard.messageId];

    // bob: a plain member and not a member of #hub-for-add-members... wait, bob IS not a member
    // of #hub in this fixture, so `channel:add_member` is not committable by bob, and
    // `agent:create` is not committable by a plain member either.
    const bobViews = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.bob.id, ids);
    const createView = bobViews.get(createCard.messageId);
    expect(createView?.canCommit).toBe(true);
    if (createView?.kind === "channel:create")
      expect(createView.initialHumans.map((human) => human.displayName)).toEqual([
        ctx.bob.username,
      ]);
    expect(bobViews.get(addMemberCard.messageId)?.canCommit).toBe(false);
    expect(bobViews.get(agentCard.messageId)?.canCommit).toBe(false);

    // alice: a member of #hub and Workspace owner, so all three are committable.
    const aliceViews = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.alice.id, ids);
    expect(aliceViews.get(createCard.messageId)?.canCommit).toBe(true);
    expect(aliceViews.get(addMemberCard.messageId)?.canCommit).toBe(true);
    expect(aliceViews.get(agentCard.messageId)?.canCommit).toBe(true);

    // Commit one and confirm the executed view exposes the committer and turns off canCommit.
    await ctx.actionCards.commitChannelCreate(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      {
        messageId: createCard.messageId,
        name: `views-${ctx.suffix}`,
        memberUserIds: [],
        memberAgentIds: [],
      },
    );
    const afterCommit = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.bob.id, [
      createCard.messageId,
    ]);
    const executedView = afterCommit.get(createCard.messageId)!;
    expect(executedView.state).toBe("executed");
    expect(executedView.canCommit).toBe(false);
    expect(executedView.committedBy).toEqual({ displayName: ctx.alice.username });

    // A reference that no longer resolves (simulating a deleted user, without violating the
    // fixture's own FK constraints) resolves to "unknown" instead of throwing.
    await ctx.db.actionCard.update({
      where: { messageId: addMemberCard.messageId },
      data: {
        payload: {
          type: "channel:add_member",
          channelId: ctx.hub.id,
          humanIds: [crypto.randomUUID()],
        },
      },
    });
    const afterMutation = await ctx.actionCards.viewsFor(ctx.workspace.id, ctx.alice.id, [
      addMemberCard.messageId,
    ]);
    const addMemberView = afterMutation.get(addMemberCard.messageId)!;
    if (addMemberView.kind === "channel:add_member")
      expect(addMemberView.humans.map((human) => human.displayName)).toEqual(["unknown"]);
  } finally {
    await ctx.cleanup();
  }
});

test("Agent-facing message reads show the card's current state suffix", async () => {
  const ctx = await setup();
  try {
    const prepared = await ctx.actionCards.prepare(ctx.principal, {
      target: `#${ctx.hub.channelName}`,
      action: { type: "channel:create", name: `agent-read-${ctx.suffix}` },
    });
    const conversations = new PrismaDirectConversationRepository(ctx.db);

    const pendingRead = await conversations.resolveAgentMessage(
      ctx.workspace.id,
      ctx.agent.id,
      prepared.messageId,
    );
    expect(pendingRead.body.endsWith("[action card: pending]")).toBe(true);

    await ctx.actionCards.commitChannelCreate(
      { workspaceId: ctx.workspace.id, actorUserId: ctx.alice.id },
      {
        messageId: prepared.messageId,
        name: `agent-read-${ctx.suffix}`,
        memberUserIds: [],
        memberAgentIds: [],
      },
    );
    const executedRead = await conversations.resolveAgentMessage(
      ctx.workspace.id,
      ctx.agent.id,
      prepared.messageId,
    );
    expect(executedRead.body.endsWith("[action card: executed]")).toBe(true);
  } finally {
    await ctx.cleanup();
  }
});
