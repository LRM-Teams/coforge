import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { buildUserAgentConversationCreateInput } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";

/**
 * The real Prisma `$queryRaw` tag flattens a nested `Prisma.sql` fragment's own bind values into
 * the parent statement's parameter list; this test's hand-rolled mock only sees the raw tagged
 * template arguments, so it must flatten the same way to assert on the resulting parameter order.
 */
function flattenSqlValues(values: unknown[]): unknown[] {
  return values.flatMap((value) =>
    value && typeof value === "object" && "values" in value && "strings" in value
      ? flattenSqlValues((value as { values: unknown[] }).values)
      : [value],
  );
}

describe("PrismaDirectConversationRepository", () => {
  test("searches only canonical messages in the Agent's Workspace and readable conversations", async () => {
    const queries: object[] = [];
    const db = {
      $queryRaw: async () => [{ query: "'release' & 'plan'" }],
      message: {
        findMany: async (input: object) => {
          queries.push(input);
          return [
            {
              id: "message-1",
              sequence: 41,
              body: "Release plan",
              createdAt: new Date("2026-09-07T10:00:00Z"),
              threadRootId: null,
              sender: { agentId: null, agent: null, user: { username: "ada" } },
              attachments: [],
              conversation: {
                channelName: "general",
                members: [{ user: { username: "ada" } }],
              },
            },
          ];
        },
      },
    } as unknown as PrismaClient;
    const result = await new PrismaDirectConversationRepository(db).searchMessages(
      "workspace-1",
      "agent-1",
      {
        query: "release plan",
        sender: "@ada",
        limit: 5,
      },
    );
    expect(queries[0]).toMatchObject({
      where: {
        workspaceId: "workspace-1",
        conversation: { members: { some: { agentId: "agent-1" } } },
        body: { search: "'release' & 'plan'" },
        sender: {
          OR: [{ user: { username: "ada" } }, { agent: { name: "ada" } }],
        },
      },
      orderBy: [
        {
          _relevance: {
            fields: ["body"],
            search: "'release' & 'plan'",
            sort: "desc",
          },
        },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: 5,
    });
    expect(result).toEqual([
      {
        id: "message-1",
        sequence: 41,
        sender: "@ada",
        target: "#general",
        body: "Release plan",
        createdAt: new Date("2026-09-07T10:00:00Z"),
        attachments: [],
      },
    ]);
    await new PrismaDirectConversationRepository(db).searchMessages("workspace-1", "agent-1", {
      query: "release",
      sort: "recent",
    });
    expect(queries[1]).toMatchObject({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

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

  test("resolves the ids a browser send needs without reading messages", async () => {
    const calls: string[] = [];
    const db = {
      conversationMember: {
        findUniqueOrThrow: async (input: object) => {
          calls.push(`member ${JSON.stringify(input)}`);
          return { id: "user-member" };
        },
      },
      message: {
        findMany: async () => {
          calls.push("messages");
          return [];
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        calls.push("conversation");
        return { id: "conversation-1" };
      }
    }

    const ids = await new TestConversationRepository(db).memberForUser(
      "workspace-1",
      "user-1",
      "agent-1",
    );

    expect(ids).toEqual({ conversationId: "conversation-1", senderMemberId: "user-member" });
    expect(calls).toEqual([
      "conversation",
      'member {"where":{"conversationId_userId":{"conversationId":"conversation-1","userId":"user-1"}},"select":{"id":true}}',
    ]);
  });

  test("pages browser history by thread roots and keeps each loaded thread intact", async () => {
    const queries: object[] = [];
    const message = (id: string, sequence: number, replies: object[] = []) => ({
      id,
      sequence,
      threadRootId: null,
      body: id,
      createdAt: new Date(sequence),
      attachments: [],
      mentions: [],
      sender: { userId: "user-1", user: { username: "alice" }, agent: null },
      replies,
    });
    const reply = (id: string, sequence: number, threadRootId: string) => ({
      ...message(id, sequence),
      threadRootId,
      replies: undefined,
    });
    const db = {
      conversation: {
        findUnique: async (input: object) => {
          queries.push(input);
          return {
            members: [
              {
                id: "user-member",
                userId: "user-1",
                agentId: null,
                threadReads: [],
                user: { username: "alice" },
                agent: null,
              },
              {
                id: "agent-member",
                userId: null,
                agentId: "agent-1",
                threadReads: [],
                user: null,
                agent: { id: "agent-1", name: "helper", displayName: "Helper" },
              },
            ],
            messages: [
              message("root-5", 5),
              message("root-3", 3, [reply("reply-4", 4, "root-3")]),
              message("root-1", 1, [reply("reply-2", 2, "root-1")]),
            ],
          };
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    const page = await new TestConversationRepository(db).openForUser(
      "workspace-1",
      "user-1",
      "agent-1",
      { beforeSequence: 6, limit: 2 },
    );

    expect(queries[0]).toMatchObject({
      select: {
        messages: {
          where: { threadRootId: null, sequence: { lt: 6 } },
          orderBy: { sequence: "desc" },
          take: 3,
        },
      },
    });
    expect(page.hasOlder).toBe(true);
    expect(page.messages.map(({ id, sequence }) => [id, sequence])).toEqual([
      ["root-3", 3],
      ["reply-4", 4],
      ["root-5", 5],
    ]);
  });

  test("polls only messages after the browser cursor, including replies to older roots", async () => {
    const queries: object[] = [];
    const db = {
      message: {
        findMany: async (input: object) => {
          queries.push(input);
          return [
            {
              id: "reply-12",
              sequence: 12,
              threadRootId: "old-root",
              body: "new reply",
              createdAt: new Date(12),
              attachments: [],
              mentions: [],
              sender: {
                userId: null,
                agentId: "agent-helper",
                user: null,
                agent: { name: "helper", displayName: "Helper" },
              },
            },
          ];
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    const updates = await new TestConversationRepository(db).updatesForUser(
      "workspace-1",
      "user-1",
      "agent-1",
      11,
    );

    expect(queries[0]).toMatchObject({
      where: { conversationId: "conversation-1", sequence: { gt: 11 } },
      orderBy: { sequence: "asc" },
      take: 100,
    });
    expect(updates).toMatchObject([
      {
        id: "reply-12",
        sequence: 12,
        threadRootId: "old-root",
        senderKind: "agent",
        senderAgentId: "agent-helper",
      },
    ]);
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
          : { agentId: null, agent: null, user: { username: "alice" } },
      attachments: [],
    }));
    const db = {
      user: { findUnique: async () => ({ id: "user-1" }) },
      conversation: { findUnique: async () => ({ id: "conversation-1" }) },
      conversationMember: {
        findUnique: async () => ({ agentReadThroughSequence: 1 }),
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

  test("projects current Task metadata only on its root Message", async () => {
    const taskStates = [
      null,
      {
        number: 31,
        status: "todo",
        owner: null,
      },
      {
        number: 31,
        status: "in_review",
        owner: {
          user: { username: "ada", displayName: "Ada Lovelace" },
          agent: null,
        },
      },
    ];
    let read = 0;
    const db = {
      $executeRaw: async () => 1,
      conversationMember: {
        findUnique: async () => ({ id: "agent-member", agentReadThroughSequence: 0 }),
        updateMany: async () => ({ count: 1 }),
      },
      threadRead: { findUnique: async () => null },
      message: {
        findMany: async (input: { where: { id?: unknown } }) => {
          if (input.where.id)
            return [
              {
                id: "12345678-1234-4234-8234-123456789abc",
                sequence: 1,
                threadRootId: null,
              },
            ];
          return [
            {
              id: read === 3 ? "reply-2" : "root-1",
              sequence: read === 3 ? 2 : 1,
              body: "Ship the release",
              createdAt: new Date(0),
              sender: { agentId: null, agent: null, user: { username: "frank" } },
              attachments: [],
              task: read === 3 ? null : taskStates[Math.min(read++, 2)],
            },
          ];
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

    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.task).toBe(
      undefined,
    );
    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.task).toEqual({
      number: 31,
      status: "todo",
    });
    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.task).toEqual({
      number: 31,
      status: "in_review",
      owner: { displayName: "Ada Lovelace", handle: "@ada" },
    });
    expect(
      (await repository.readMessages("workspace-1", "agent-1", "@frank:12345678"))[0]?.task,
    ).toBe(undefined);
  });

  test("an unanchored canonical read advances across a missing sequence", async () => {
    const updates: object[] = [];
    const db = {
      conversationMember: {
        findUnique: async () => ({ agentReadThroughSequence: 1 }),
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
            attachments: [],
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
    const queries: unknown[][] = [];
    const row = (overrides: Partial<Record<string, unknown>>) => ({
      id: "message",
      sequence: 1,
      body: "body",
      conversationId: "conversation-0",
      threadRootId: null,
      senderMemberId: "member-alice",
      deliveryId: "delivery",
      senderUsername: "alice",
      channelName: null,
      userUsername: "alice",
      unreadCount: 120,
      globalRank: 1,
      ...overrides,
    });
    const rows = [
      ...Array.from({ length: 100 }, (_, offset) =>
        row({
          id: `conversation-0-message-${offset + 5}`,
          sequence: offset + 5,
          body: `body-${offset + 5}`,
          deliveryId: `conversation-0-delivery-${offset + 5}`,
          globalRank: offset + 1,
        }),
      ),
      // Past the resume budget: contributes its target's count only, so a missing
      // delivery here must not fail recovery.
      row({
        id: "conversation-0-reply-130",
        sequence: 130,
        threadRootId: "root-1",
        deliveryId: null,
        unreadCount: 3,
        globalRank: 121,
      }),
      row({
        id: "conversation-1-message-9",
        sequence: 9,
        conversationId: "conversation-1",
        senderMemberId: "member-bob",
        senderUsername: "bob",
        userUsername: "bob",
        unreadCount: 75,
        globalRank: 124,
      }),
    ];
    const db = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(flattenSqlValues(values));
        return rows;
      },
      messageMention: { findMany: async () => [] },
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual(["workspace-1", "agent-1", "agent-1", 100]);
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
    expect(result.unreadSummary).toEqual({ "@alice": 120, "@alice:root-1": 3, "@bob": 75 });
  });

  test("names channel senders individually and direct senders by the conversation user", async () => {
    const db = {
      messageMention: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 7,
          body: "from carol",
          conversationId: "channel-1",
          threadRootId: "root-1",
          senderMemberId: "member-carol",
          deliveryId: "delivery-1",
          senderUsername: "carol",
          channelName: "general",
          userUsername: "ada",
          unreadCount: 2,
          globalRank: 1,
        },
        {
          id: "message-2",
          sequence: 8,
          body: "system notice",
          conversationId: "channel-1",
          threadRootId: "root-1",
          senderMemberId: null,
          deliveryId: "delivery-2",
          senderUsername: null,
          channelName: "general",
          userUsername: "ada",
          unreadCount: 2,
          globalRank: 2,
        },
      ],
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(result.resumeMessages.map((m) => [m.target, m.latestSender])).toEqual([
      ["#general:root-1", "@carol"],
      ["#general:root-1", "system"],
    ]);
    expect(result.unreadSummary).toEqual({ "#general:root-1": 2 });
  });

  test("rejects recovery when an unread message has no Agent delivery", async () => {
    const db = {
      messageMention: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "body",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-alice",
          deliveryId: null,
          senderUsername: "alice",
          channelName: null,
          userUsername: "alice",
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("has no delivery");
  });

  test("rejects recovery for a conversation without a public target", async () => {
    const db = {
      messageMention: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "body",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: null,
          deliveryId: "delivery-1",
          senderUsername: null,
          channelName: null,
          userUsername: null,
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("no public user target");
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
              conversation: { channelName: null, members: [{ user: { username: "alice" } }] },
              message: {
                body: "pending body",
                sender: { user: { username: "alice" } },
                mentions: [],
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
      where: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        receivedAt: null,
      },
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

  test("reads Agent-authored pending deliveries with the Agent handle", async () => {
    const db = {
      agentMessageDelivery: {
        findMany: async () => [
          {
            deliveryId: "delivery-agent",
            messageId: "message-agent",
            conversationId: "conversation-1",
            sequence: 5,
            conversation: { channelName: "general", members: [] },
            message: {
              body: "@reviewer please review",
              sender: {
                agentId: "sender-agent",
                agent: { name: "helper" },
                user: null,
              },
              mentions: [],
            },
          },
        ],
      },
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
        "workspace-1",
        "agent-1",
      ),
    ).resolves.toEqual([
      {
        messageId: "message-agent",
        deliveryId: "delivery-agent",
        conversationId: "conversation-1",
        sequence: 5,
        target: "#general",
        latestSender: "@helper",
        body: "@reviewer please review",
      },
    ]);
  });

  test("sendAgentMessage links two attachments in send order and rejects one the Agent did not upload", async () => {
    const updates: { where: unknown; data: unknown }[] = [];
    const attachmentsById: Record<
      string,
      {
        id: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        uploaderAgentId: string;
      }
    > = {
      "attach-b": {
        id: "attach-b",
        fileName: "b.txt",
        contentType: "text/plain",
        sizeBytes: 2,
        uploaderAgentId: "agent-1",
      },
      "attach-a": {
        id: "attach-a",
        fileName: "a.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        uploaderAgentId: "agent-1",
      },
      "attach-foreign": {
        id: "attach-foreign",
        fileName: "f.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        uploaderAgentId: "agent-2",
      },
    };
    const tx = {
      $queryRaw: async () => [],
      message: {
        findFirst: async () => null,
        create: async ({ data }: { data: { body: string } }) => ({
          id: "message-new",
          body: data.body,
          createdAt: new Date("2026-09-17T00:00:00Z"),
          sequence: 1,
          deliveries: [],
        }),
      },
      attachment: {
        findFirst: async ({
          where,
        }: {
          where: { id: string; uploaderAgentId: string; messageId: null };
        }) => {
          const row = attachmentsById[where.id];
          if (!row || row.uploaderAgentId !== where.uploaderAgentId) return null;
          return {
            id: row.id,
            fileName: row.fileName,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
          };
        },
        update: async ({ where, data }: { where: unknown; data: unknown }) => {
          updates.push({ where, data });
          return {};
        },
      },
      conversationMember: { findMany: async () => [] },
      threadFollow: { createMany: async () => {} },
    };
    const db = {
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
          members: [
            { id: "member-agent", agentId: "agent-1", userId: null },
            { id: "member-user", agentId: null, userId: "user-1" },
          ],
        }),
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaDirectConversationRepository(db);

    const result = await repository.sendAgentMessage("conversation-1", "agent-1", "two files", [
      "attach-b",
      "attach-a",
    ]);

    // Order matches send order (B, then A), not any other reordering.
    expect(result.attachments.map((a) => a.id)).toEqual(["attach-b", "attach-a"]);
    expect(updates).toEqual([
      { where: { id: "attach-b" }, data: { messageId: "message-new", position: 0 } },
      { where: { id: "attach-a" }, data: { messageId: "message-new", position: 1 } },
    ]);

    // The uploaderAgentId gap ADR 0022 named: a different Agent's unlinked attachment is
    // rejected, closing the gap ADR 0023's upload route opened it up to fix.
    await expect(
      repository.sendAgentMessage("conversation-1", "agent-1", "not mine", ["attach-foreign"]),
    ).rejects.toThrow("attachment is not available for this message");
  });

  test("sendMessage links two human-uploaded attachments in send order", async () => {
    const updates: { where: unknown; data: unknown }[] = [];
    const attachmentsById: Record<
      string,
      { id: string; fileName: string; contentType: string; sizeBytes: number; objectKey: string }
    > = {
      "attach-b": {
        id: "attach-b",
        fileName: "b.txt",
        contentType: "text/plain",
        sizeBytes: 2,
        objectKey: "key-b",
      },
      "attach-a": {
        id: "attach-a",
        fileName: "a.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        objectKey: "key-a",
      },
    };
    const tx = {
      $queryRaw: async () => [],
      message: {
        findFirst: async () => null,
        create: async ({ data }: { data: { body: string } }) => ({
          id: "message-new",
          body: data.body,
          createdAt: new Date("2026-09-17T00:00:00Z"),
          sequence: 1,
          deliveries: [{ deliveryId: "delivery-1" }],
        }),
      },
      attachment: {
        findFirst: async ({ where }: { where: { id: string; uploaderId: string } }) => {
          const row = attachmentsById[where.id];
          if (!row || where.uploaderId !== "user-1") return null;
          return row;
        },
        update: async ({ where, data }: { where: unknown; data: unknown }) => {
          updates.push({ where, data });
          return {};
        },
      },
    };
    const db = {
      conversation: {
        findUnique: async () => ({
          workspaceId: "workspace-1",
          members: [
            { id: "member-user", userId: "user-1", agentId: null, user: { username: "alice" } },
            {
              id: "member-agent",
              userId: null,
              agentId: "agent-1",
              agent: { name: "helper", computerId: null },
            },
          ],
        }),
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaDirectConversationRepository(db);

    const result = await repository.sendMessage(
      "conversation-1",
      "member-user",
      "user-1",
      "two files",
      ["attach-b", "attach-a"],
    );

    expect(result.attachments.map((a) => a.id)).toEqual(["attach-b", "attach-a"]);
    expect(updates).toEqual([
      { where: { id: "attach-b" }, data: { messageId: "message-new", position: 0 } },
      { where: { id: "attach-a" }, data: { messageId: "message-new", position: 1 } },
    ]);
  });

  test("unread counts group per DM by the Agent whose row owns the badge", async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const db = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push({ sql: strings.join(""), values: flattenSqlValues(values) });
        return [
          { agentId: "agent-1", unread: 3 },
          { agentId: "agent-2", unread: 0 },
        ];
      },
    } as unknown as PrismaClient;

    const rows = await new PrismaDirectConversationRepository(db).unreadCountsForUser(
      "workspace-1",
      "user-1",
    );
    expect(rows).toEqual([
      { agentId: "agent-1", unread: 3 },
      { agentId: "agent-2", unread: 0 },
    ]);
    const statement = queries[0]!;
    expect(statement.sql).toContain('"directKey" IS NOT NULL');
    expect(statement.sql).toContain('"threadRootId" IS NULL');
    expect(statement.sql).toContain('> cm."readThroughSequence"');
    // The badge key is the conversation's agent member row, never the viewer's own row.
    expect(statement.sql).toContain('am."agentId"');
    expect(statement.sql).not.toContain('cm."agentId"');
    expect(statement.values).toContain("workspace-1");
    expect(statement.values).toContain("user-1");
  });

  test("markRead clamps the boundary to the conversation end and stays monotone", async () => {
    let updated: { where: object; data: object } | undefined;
    const db = {
      agent: {
        findFirst: async () => ({ id: "agent-1" }),
      },
      conversation: {
        findUnique: async () => ({ id: "conversation-1" }),
      },
      $transaction: async (callback: (tx: object) => Promise<void>) =>
        callback({
          message: {
            findFirst: async () => ({ sequence: 7 }),
          },
          conversationMember: {
            updateMany: async (input: { where: object; data: object }) => {
              updated = input;
            },
          },
        }),
    } as unknown as PrismaClient;

    // An over-eager client is clamped to the conversation's current end.
    await new PrismaDirectConversationRepository(db).markReadForUser(
      "workspace-1",
      "user-1",
      "agent-1",
      10_000,
    );
    expect(updated).toEqual({
      where: {
        conversationId: "conversation-1",
        userId: "user-1",
        readThroughSequence: { lt: 7 },
        leftAt: null,
      },
      data: { readThroughSequence: 7 },
    });

    // An empty conversation refuses to move the cursor to a non-positive boundary.
    updated = undefined;
    const emptyDb = {
      agent: {
        findFirst: async () => ({ id: "agent-1" }),
      },
      conversation: {
        findUnique: async () => ({ id: "conversation-1" }),
      },
      $transaction: async (callback: (tx: object) => Promise<void>) =>
        callback({
          message: {
            findFirst: async () => undefined,
          },
          conversationMember: {
            updateMany: async (input: { where: object; data: object }) => {
              updated = input;
            },
          },
        }),
    } as unknown as PrismaClient;
    await new PrismaDirectConversationRepository(emptyDb).markReadForUser(
      "workspace-1",
      "user-1",
      "agent-1",
      5,
    );
    expect(updated).toBeUndefined();
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
            conversation: { channelName: null, members: [{ user: { username: "Invalid Name" } }] },
            message: {
              body: "body",
              sender: { user: { username: "Invalid Name" } },
            },
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
