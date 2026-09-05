import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { buildUserAgentConversationCreateInput } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";

describe("PrismaDirectConversationRepository", () => {
  test("scopes a delivery ACK to the Agent's current Computer assignment", async () => {
    const updates: object[] = [];
    const db = {
      agentMessageDelivery: {
        updateMany: async (input: object) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    await new PrismaDirectConversationRepository(db).receiveDeliveryAck({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      messageId: "message-1",
      sequence: 7,
    });

    expect(updates[0]).toMatchObject({
      where: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        messageId: "message-1",
        sequence: 7,
        agent: { computerId: "computer-1" },
      },
    });
  });

  test("creates a User-Agent conversation through checked relation inputs", () => {
    expect(buildUserAgentConversationCreateInput("workspace-1", "user-1", "agent-1")).toEqual({
      workspace: { connect: { id: "workspace-1" } },
      directKey: "agent:agent-1|user:user-1",
      members: {
        create: [
          {
            workspace: { connect: { id: "workspace-1" } },
            user: { connect: { id: "user-1" } },
          },
          {
            workspace: { connect: { id: "workspace-1" } },
            agent: { connect: { id: "agent-1" } },
          },
        ],
      },
    });
  });

  test("advances across the Agent's own message when reading the next canonical range", async () => {
    const updates: object[] = [];
    const queries: object[] = [];
    const rows = [2, 3].map((sequence) => ({
      id: `message-${sequence}`,
      sequence,
      body: `body-${sequence}`,
      createdAt: new Date(0),
      sender:
        sequence === 2
          ? { agentId: "agent-1", agent: { name: "helper" } }
          : { agentId: null, agent: null },
      attachment: null,
    }));
    const db = {
      user: { findUnique: async () => ({ id: "user-1" }) },
      conversation: { findUnique: async () => ({ id: "conversation-1" }) },
      conversationMember: {
        findFirst: async () => ({ agentReadThroughSequence: 1 }),
        updateMany: async (input: object) => {
          updates.push(input);
          return { count: 1 };
        },
      },
      message: {
        findMany: async (input: object) => {
          queries.push(input);
          return rows;
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async userIdForUsername() {
        return "user-1";
      }
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }
    const repository = new TestConversationRepository(db);

    const result = await repository.readMessagesPage("workspace-1", "agent-1", "@alice", {
      throughSequence: 3,
    });
    await repository.readMessagesPage("workspace-1", "agent-1", "@alice", {
      fromSequence: 3,
      throughSequence: 3,
    });

    expect(result.messages.map(({ sequence, sender }) => [sequence, sender])).toEqual([
      [2, "@helper"],
      [3, "@alice"],
    ]);
    expect(queries[0]).toMatchObject({
      where: { conversationId: "conversation-1", sequence: { gte: 2, lte: 3 } },
    });
    expect(updates).toEqual([
      {
        where: {
          conversationId: "conversation-1",
          agentId: "agent-1",
          agentReadThroughSequence: { lt: 3 },
        },
        data: { agentReadThroughSequence: 3 },
      },
    ]);
  });

  test("an unanchored canonical read advances across a missing sequence", async () => {
    const updates: object[] = [];
    const db = {
      conversationMember: {
        findFirst: async () => ({ agentReadThroughSequence: 1 }),
        updateMany: async (input: object) => {
          updates.push(input);
          return { count: 1 };
        },
      },
      message: {
        findMany: async () => [
          {
            id: "message-3",
            sequence: 3,
            body: "pending",
            createdAt: new Date(0),
            sender: { agentId: null, agent: null },
            attachment: null,
          },
        ],
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async userIdForUsername() {
        return "user-1";
      }
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    await new TestConversationRepository(db).readMessagesPage("workspace-1", "agent-1", "@alice");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ data: { agentReadThroughSequence: 3 } });
  });

  test("bounds and monotonically advances only the authorized Agent conversation", async () => {
    const updates: object[] = [];
    const db = {
      message: { findFirst: async () => ({ sequence: 9 }) },
      conversationMember: {
        updateMany: async (input: object) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async userIdForUsername(target: string) {
        expect(target).toBe("@alice");
        return "user-1";
      }
      override async getOrCreateUserAgent(workspaceId: string, userId: string, agentId: string) {
        expect([workspaceId, userId, agentId]).toEqual(["workspace-1", "user-1", "agent-1"]);
        return { id: "conversation-1" };
      }
    }

    const bounded = await new TestConversationRepository(db).advanceAgentReadThrough(
      "workspace-1",
      "agent-1",
      "@alice",
      999,
    );

    expect(bounded).toBe(9);
    expect(updates).toEqual([
      {
        where: {
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          agentReadThroughSequence: { lt: 9 },
        },
        data: { agentReadThroughSequence: 9 },
      },
    ]);
  });

  test("returns zero without advancing when the authorized conversation has no messages", async () => {
    let updates = 0;
    const db = {
      message: { findFirst: async () => null },
      conversationMember: { updateMany: async () => void updates++ },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async userIdForUsername() {
        return "user-1";
      }
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    expect(
      await new TestConversationRepository(db).advanceAgentReadThrough(
        "workspace-1",
        "agent-1",
        "@alice",
        999,
      ),
    ).toBe(0);
    expect(updates).toBe(0);
  });

  test("builds a stable per-target oldest-first recovery batch with a global limit", async () => {
    const takes: number[] = [];
    const memberQueries: object[] = [];
    const messageConversations: string[] = [];
    const transactionOptions: object[] = [];
    const db = {
      $transaction: async (operation: (tx: unknown) => unknown, options: object) => {
        transactionOptions.push(options);
        return operation(db);
      },
      conversationMember: {
        findMany: async (input: object) => {
          memberQueries.push(input);
          return ["alice", "bob"].map((username, index) => ({
            conversationId: `conversation-${index}`,
            agentReadThroughSequence: 4,
            conversation: { members: [{ user: { username } }] },
          }));
        },
      },
      message: {
        count: async () => 75,
        findMany: async ({ where, take }: { where: { conversationId: string }; take: number }) => {
          takes.push(take);
          messageConversations.push(where.conversationId);
          const count = Math.min(60, take);
          return Array.from({ length: count }, (_, offset) => ({
            id: `${where.conversationId}-message-${offset + 5}`,
            sequence: offset + 5,
            body: `body-${offset + 5}`,
            deliveries: [{ deliveryId: `${where.conversationId}-delivery-${offset + 5}` }],
          }));
        },
      },
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(takes).toEqual([100, 40]);
    expect(memberQueries[0]).toMatchObject({ orderBy: { conversationId: "asc" } });
    expect(messageConversations).toEqual(["conversation-0", "conversation-1"]);
    expect(result.resumeMessages).toHaveLength(100);
    expect(result.resumeMessages.slice(0, 2)).toEqual([
      {
        messageId: "conversation-0-message-5",
        deliveryId: "conversation-0-delivery-5",
        conversationId: "conversation-0",
        sequence: 5,
        target: "@alice",
        latestSender: "@alice",
        body: "body-5",
      },
      {
        messageId: "conversation-0-message-6",
        deliveryId: "conversation-0-delivery-6",
        conversationId: "conversation-0",
        sequence: 6,
        target: "@alice",
        latestSender: "@alice",
        body: "body-6",
      },
    ]);
    expect(result.unreadSummary).toEqual({ "@alice": 75, "@bob": 75 });
    expect(transactionOptions).toEqual([{ isolationLevel: "RepeatableRead" }]);
  });

  test("counts later targets without querying messages after the recovery budget is exhausted", async () => {
    const queriedConversations: string[] = [];
    const db = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(db),
      conversationMember: {
        findMany: async () =>
          ["alice", "bob"].map((username, index) => ({
            conversationId: `conversation-${index}`,
            agentReadThroughSequence: 0,
            conversation: { members: [{ user: { username } }] },
          })),
      },
      message: {
        count: async () => 100,
        findMany: async ({ where }: { where: { conversationId: string } }) => {
          queriedConversations.push(where.conversationId);
          return Array.from({ length: 100 }, (_, offset) => ({
            id: `message-${offset + 1}`,
            sequence: offset + 1,
            body: "body",
            deliveries: [{ deliveryId: `delivery-${offset + 1}` }],
          }));
        },
      },
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(queriedConversations).toEqual(["conversation-0"]);
    expect(result.unreadSummary).toEqual({ "@alice": 100, "@bob": 100 });
  });

  test("rejects recovery when an unread message has no Agent delivery", async () => {
    const db = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(db),
      conversationMember: {
        findMany: async () => [
          {
            conversationId: "conversation-1",
            agentReadThroughSequence: 0,
            conversation: { members: [{ user: { username: "alice" } }] },
          },
        ],
      },
      message: {
        count: async () => 1,
        findMany: async () => [{ id: "message-1", sequence: 1, body: "body", deliveries: [] }],
      },
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("has no delivery");
  });

  test("reads all scoped unacknowledged deliveries oldest-first", async () => {
    const queries: object[] = [];
    const db = {
      agentMessageDelivery: {
        findMany: async (input: object) => {
          queries.push(input);
          return [
            {
              deliveryId: "delivery-1",
              messageId: "message-1",
              conversationId: "conversation-1",
              sequence: 4,
              message: {
                body: "pending body",
                sender: { user: { username: "alice" } },
              },
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
      "workspace-1",
      "agent-1",
    );

    expect(queries[0]).toMatchObject({
      where: { workspaceId: "workspace-1", agentId: "agent-1", receivedAt: null },
      orderBy: [{ createdAt: "asc" }, { deliveryId: "asc" }],
    });
    expect(queries[0]).not.toHaveProperty("take");
    expect(result).toEqual([
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 4,
        target: "@alice",
        latestSender: "@alice",
        body: "pending body",
      },
    ]);
  });

  test("rejects a pending delivery without a valid public username target", async () => {
    const db = {
      agentMessageDelivery: {
        findMany: async () => [
          {
            deliveryId: "delivery-1",
            messageId: "message-1",
            conversationId: "conversation-1",
            sequence: 1,
            message: { body: "body", sender: { user: { username: "Invalid Name" } } },
          },
        ],
      },
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
        "workspace-1",
        "agent-1",
      ),
    ).rejects.toThrow("public @username");
  });
});
