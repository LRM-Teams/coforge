import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { AgentDeletion } from "@/server/agents/agent-deletion.server";
import { PrismaAgentDeletionStore } from "@/server/db/repositories/agent-deletion.repositories.server";
import { PrismaAgentRepository } from "@/server/db/repositories/agent.repositories.server";
import { PrismaDirectConversationRepository } from "@/server/db/repositories/direct-conversation.repositories.server";
import { enrollGeneralChannel } from "@/server/conversations/public-channels.server";
import { WorkspaceMembers, workspaceMemberRole } from "@/server/workspaces/members.server";
import { findWorkspaceUser } from "@/server/agents/agent-user-info.server";
import type { AgentVisibilityViewer } from "@/server/agents/agent-visibility.server";
import { TaskBoard } from "@/server/tasks/task-board.server";

/**
 * End-to-end Agent deletion against local PostgreSQL. Drives the real `AgentDeletion`
 * and `PrismaAgentDeletionStore`, then asserts through the *other* live-view seams — the Members
 * directory, the DM read path, the by-name profile lookup, the message projection, the repository
 * listings and the unique Agent name constraint — so the test proves the delete actually makes the
 * Agent inert rather than only that one row changed.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `agent-session-persistence.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `del-owner-${suffix}` } });
  const member = await db.user.create({ data: { username: `del-member-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `del-${suffix}`,
      name: "Agent deletion",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `doomed-${suffix}`,
      displayName: "Doomed",
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
  await enrollGeneralChannel(db, workspace.id);
  // A Computer assignment, so the delete's runtime Stop is genuinely attempted.
  const computer = await db.computer.create({
    data: {
      ownerId: owner.id,
      machineId: crypto.randomUUID(),
      name: `box-${suffix}`,
      displayName: "Box",
    },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  await db.agent.update({ where: { id: agent.id }, data: { computerId: computer.id } });
  return {
    db,
    workspace,
    owner,
    member,
    agent: { ...agent, computerId: computer.id },
    computer,
  };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

/** The real composition, with the runtime stop captured instead of published. */
function deletionFor(db: PrismaClient, stops: string[]) {
  return new AgentDeletion(
    new PrismaAgentRepository(db),
    new PrismaAgentDeletionStore(db),
    {
      stop: async (intent) => {
        stops.push(intent.agentId);
      },
    },
    { run: async (_agentId, callback) => callback() },
  );
}

test.skipIf(!connectionString)(
  "deleting an Agent hides it from every live view and keeps its history readable",
  async () => {
    const { db, workspace, owner, member, agent } = await setup();
    // The Agent's own creator; trivially visible regardless of `visibility`, so this
    // test's `findWorkspaceUser` calls exercise deletion, never a visibility rejection.
    const ownerViewer: AgentVisibilityViewer = { kind: "user", userId: owner.id, role: "owner" };
    try {
      // Seed a real DM message from the Agent, so there is history to preserve.
      const conversations = new PrismaDirectConversationRepository(db);
      const opened = await conversations.getOrCreateUserAgent(workspace.id, owner.id, agent.id);
      const senderMemberId = (
        await db.conversationMember.findUniqueOrThrow({
          where: { conversationId_agentId: { conversationId: opened.id, agentId: agent.id } },
          select: { id: true },
        })
      ).id;
      await db.message.create({
        data: {
          conversationId: opened.id,
          workspaceId: workspace.id,
          senderMemberId,
          body: "Hi, I am here.",
          sequence: 1,
        },
      });

      // Visible everywhere before the delete.
      expect(
        (
          await new WorkspaceMembers(db).agentPage(workspace.id, owner.id, {
            owner: "all",
            query: "",
            limit: 50,
          })
        ).items.map((a) => a.id),
      ).toContain(agent.id);
      expect(await findWorkspaceUser(db, workspace.id, agent.name, ownerViewer)).toBeDefined();

      const stops: string[] = [];
      const result = await deletionFor(db, stops).delete(
        {
          userId: owner.id,
          workspaceId: workspace.id,
          role: await workspaceMemberRole(db, workspace.id, owner.id),
        },
        agent.id,
      );

      expect(result.outcome).toBe("deleted");
      // The runtime stop was attempted exactly once, for this Agent.
      expect(stops).toEqual([agent.id]);

      // Row-level effects: the delete marker and the soft-left membership.
      expect(
        (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt,
      ).not.toBeNull();
      expect(
        (
          await db.conversationMember.findUniqueOrThrow({
            where: { conversationId_agentId: { conversationId: opened.id, agentId: agent.id } },
          })
        ).leftAt,
      ).not.toBeNull();

      // Hidden from the Members directory and from the by-name profile lookup.
      expect(
        (
          await new WorkspaceMembers(db).agentPage(workspace.id, owner.id, {
            owner: "all",
            query: "",
            limit: 50,
          })
        ).items.map((a) => a.id),
      ).not.toContain(agent.id);
      expect(await findWorkspaceUser(db, workspace.id, agent.name, ownerViewer)).toBeUndefined();

      // Live listings exclude it; getById and the deleted listing still see it, so recovery can
      // stop a process the Daemon still reports as running.
      const agents = new PrismaAgentRepository(db);
      expect((await agents.listInWorkspace(workspace.id)).map((a) => a.id)).not.toContain(agent.id);
      expect(
        (await agents.listDeletedForComputer(workspace.id, agent.computerId!)).map((a) => a.id),
      ).toContain(agent.id);
      expect((await agents.getById(agent.id))?.deletedAt).not.toBeNull();

      // History stays readable through the same seam the browser DM view uses, and the projection
      // marks the sender deleted so the row renders greyed with the DELETED badge.
      const page = await conversations.openForUser(workspace.id, owner.id, agent.id);
      const sent = page.messages.find((message) => message.body === "Hi, I am here.");
      expect(sent).toBeDefined();
      expect(sent!.senderDeleted).toBe(true);
      // The DM projection shows the Agent's display name; the handle is the mention target.
      expect(sent!.senderName).toBe("Doomed");
      expect(sent!.senderAgentId).toBe(agent.id);

      // The name stays reserved, so a new Agent cannot silently inherit this history.
      await expect(
        Promise.resolve(
          db.agent.create({
            data: {
              workspaceId: workspace.id,
              name: agent.name,
              displayName: "Replacement",
              ownerId: owner.id,
              runtimeConfig: {
                runtime: "pi",
                provider: { kind: "default" },
                model: "",
                modelProvider: "",
                reasoning: "",
              },
            },
          }),
        ),
      ).rejects.toThrow();

      // A plain member may not delete, even though they are a Workspace member.
      await expect(
        Promise.resolve(
          deletionFor(db, stops).delete(
            {
              userId: member.id,
              workspaceId: workspace.id,
              role: await workspaceMemberRole(db, workspace.id, member.id),
            },
            agent.id,
          ),
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

      // A repeated delete is an idempotent no-op: the original marker stays and no second stop is
      // sent.
      const firstDeletedAt = (await db.agent.findUniqueOrThrow({ where: { id: agent.id } }))
        .deletedAt;
      const repeated = await deletionFor(db, stops).delete(
        {
          userId: owner.id,
          workspaceId: workspace.id,
          role: await workspaceMemberRole(db, workspace.id, owner.id),
        },
        agent.id,
      );
      expect(repeated.outcome).toBe("already-deleted");
      expect(stops).toEqual([agent.id]);
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt).toEqual(
        firstDeletedAt,
      );
    } finally {
      await teardown(db, workspace.id, [owner.id, member.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "deletion revokes active Agent API keys and cancels scheduled Reminders",
  async () => {
    const { db, workspace, owner, agent, computer } = await setup();
    try {
      await db.agentApiKey.create({
        data: {
          apiKeyHash: crypto.randomUUID().replaceAll("-", ""),
          agentId: agent.id,
          workspaceId: workspace.id,
          ownerId: owner.id,
          computerId: computer.id,
        },
      });
      const reminder = await db.reminder.create({
        data: {
          workspaceId: workspace.id,
          ownerAgentId: agent.id,
          computerId: computer.id,
          title: "standup",
          target: `@${agent.name}`,
          messageId: crypto.randomUUID(),
          fireAt: new Date(Date.now() + 3_600_000),
          status: "scheduled",
        },
      });

      await deletionFor(db, []).delete(
        { userId: owner.id, workspaceId: workspace.id, role: "owner" },
        agent.id,
      );

      expect(
        (await db.agentApiKey.findFirstOrThrow({ where: { agentId: agent.id } })).revokedAt,
      ).not.toBeNull();
      expect((await db.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).status).toBe(
        "canceled",
      );
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a deleted Agent is neither an assignable Task target nor a Task recipient",
  async () => {
    const { db, workspace, owner, agent } = await setup();
    try {
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const board = new TaskBoard(db);
      const principal = { workspaceId: workspace.id, userId: owner.id };

      // Control: while the Agent is live it is both assignable and a delivery recipient.
      const before = await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        title: "Before delete",
        assignee: `@${agent.name}`,
      });
      expect(before.assignmentReceipt).toMatchObject({ assignee: `@${agent.name}` });
      const beforeMessage = await db.message.findUniqueOrThrow({
        where: { id: before.tasks[0]!.messageId },
        select: { deliveries: { select: { agentId: true } } },
      });
      expect(beforeMessage.deliveries.map((delivery) => delivery.agentId)).toContain(agent.id);

      await deletionFor(db, []).delete(
        { userId: owner.id, workspaceId: workspace.id, role: "owner" },
        agent.id,
      );

      // The `@handle` no longer resolves to a conversation member, so the assignment is refused
      // exactly like any other unknown handle.
      await expect(
        board.execute(principal, {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: general.id,
          title: "After delete",
          assignee: `@${agent.name}`,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // An ordinary Task in the channel no longer creates a delivery row for the deleted Agent, so
      // nothing can wake it through the Task path.
      const after = await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        title: "No delivery after delete",
      });
      const afterMessage = await db.message.findUniqueOrThrow({
        where: { id: after.tasks[0]!.messageId },
        select: { deliveries: { select: { agentId: true } } },
      });
      expect(afterMessage.deliveries.map((delivery) => delivery.agentId)).not.toContain(agent.id);
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "the weekly-report assistant is refused and survives the attempt",
  async () => {
    const { db, workspace, owner } = await setup();
    try {
      const assistant = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `assistant-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "周报助手",
          ownerId: owner.id,
          runtimeConfig: {
            runtime: "coforge",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      await db.weeklyReportAssistant.create({
        data: { workspaceId: workspace.id, userId: owner.id, agentId: assistant.id },
      });

      const stops: string[] = [];
      const result = await deletionFor(db, stops).delete(
        { userId: owner.id, workspaceId: workspace.id, role: "owner" },
        assistant.id,
      );

      expect(result.outcome).toBe("protected");
      expect(stops).toEqual([]);
      expect(
        (await db.agent.findUniqueOrThrow({ where: { id: assistant.id } })).deletedAt,
      ).toBeNull();
    } finally {
      await teardown(db, workspace.id, [owner.id]);
    }
  },
);
