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
              sender: {
                agentId: null,
                agent: null,
                user: { username: "ada", description: "" },
              },
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
        senderKind: "human",
        senderHandle: "ada",
        senderDescription: "",
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
    // A backward page read with a `beforeSequence` cursor always has newer content above it, which
    // is what tells the bounded window that its newest retained page is no longer the live tail.
    expect(page.hasNewer).toBe(true);
    expect(page.messages.map(({ id, sequence }) => [id, sequence])).toEqual([
      ["root-3", 3],
      ["reply-4", 4],
      ["root-5", 5],
    ]);
  });

  test("pages towards the live end from a retained page, and reports the tail it reaches", async () => {
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
    const rowsFor = (messages: object[]) =>
      ({
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
                  user: {
                    id: "user-1",
                    username: "alice",
                    displayName: "Alice",
                    description: "",
                    avatarObjectKey: null,
                  },
                  agent: null,
                },
                {
                  id: "agent-member",
                  userId: null,
                  agentId: "agent-1",
                  threadReads: [],
                  user: null,
                  agent: {
                    id: "agent-1",
                    name: "helper",
                    displayName: "Helper",
                    description: "",
                  },
                },
              ],
              messages,
            };
          },
        },
      }) as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    // One row more than the limit: the fetch did not reach the tail.
    const midWindow = await new TestConversationRepository(
      rowsFor([message("root-5", 5, [reply("reply-6", 6, "root-5")]), message("root-7", 7)]),
    ).openForUser("workspace-1", "user-1", "agent-1", { afterSequence: 4, limit: 1 });
    expect(queries[0]).toMatchObject({
      select: {
        messages: {
          where: { threadRootId: null, sequence: { gt: 4 } },
          orderBy: { sequence: "asc" },
          take: 2,
        },
      },
    });
    expect(midWindow.hasOlder).toBe(true);
    expect(midWindow.hasNewer).toBe(true);
    // The page itself is the first `limit` top-level rows with their replies, oldest first — the
    // overflow row that only proved there was more is dropped from the reader's side.
    expect(midWindow.messages.map(({ id, sequence }) => [id, sequence])).toEqual([
      ["root-5", 5],
      ["reply-6", 6],
    ]);
    // The viewer's own row is in the list — that is what makes a mention *of the viewer*
    // resolvable, and what the pane's formatter and the composer both read.
    expect(midWindow.viewerHandle).toBe("alice");
    expect(midWindow.mentionables).toEqual([
      {
        kind: "user",
        id: "user-1",
        handle: "alice",
        label: "Alice",
        description: "",
        avatarUrl: null,
        mentionScore: 0,
      },
      {
        kind: "agent",
        id: "agent-1",
        handle: "helper",
        label: "Helper",
        description: "",
        mentionScore: 0,
      },
    ]);

    // No overflow: this page is the live tail.
    const atTail = await new TestConversationRepository(
      rowsFor([message("root-9", 9)]),
    ).openForUser("workspace-1", "user-1", "agent-1", { afterSequence: 6, limit: 20 });
    expect(atTail.hasOlder).toBe(true);
    expect(atTail.hasNewer).toBe(false);
    expect(atTail.messages.map((message) => message.sequence)).toEqual([9]);
  });

  test("the initial page is the live tail with nothing newer to fetch", async () => {
    const db = {
      conversation: {
        findUnique: async () => ({
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
          messages: [],
        }),
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
    );
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(false);
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
          ? { agentId: "agent-1", agent: { name: "helper", description: "" }, user: null }
          : { agentId: null, agent: null, user: { username: "alice", description: "" } },
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

    expect(
      result.messages.map(({ sequence, senderKind, senderHandle }) => [
        sequence,
        senderKind,
        senderHandle,
      ]),
    ).toEqual([
      [2, "agent", "helper"],
      [3, "human", "alice"],
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
              sender: { agentId: null, agent: null, user: { username: "frank", description: "" } },
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
            sender: { agentId: null, agent: null, user: { username: "alice", description: "" } },
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
      senderAgentName: null,
      senderAgentDescription: null,
      senderUsername: "alice",
      senderUserDescription: "",
      channelName: null,
      otherUsername: "alice",
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
        otherUsername: "bob",
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
        latestSenderKind: "human",
        latestSenderHandle: "alice",
        latestSenderDescription: "",
        body: "body-5",
      },
      {
        messageId: "conversation-0-message-6",
        deliveryId: "conversation-0-delivery-6",
        conversationId: "conversation-0",
        sequence: 6,
        target: "@alice",
        latestSenderKind: "human",
        latestSenderHandle: "alice",
        latestSenderDescription: "",
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
          senderAgentName: null,
          senderAgentDescription: null,
          senderUsername: "carol",
          senderUserDescription: "",
          channelName: "general",
          otherUsername: "ada",
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
          otherUsername: "ada",
          unreadCount: 2,
          globalRank: 2,
        },
      ],
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(
      result.resumeMessages.map((m) => [m.target, m.latestSenderKind, m.latestSenderHandle]),
    ).toEqual([
      ["#general:root-1", "human", "carol"],
      ["#general:root-1", "system", ""],
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
          otherUsername: "alice",
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("has no delivery");
  });

  test("rejects recovery for a direct conversation with no other member to target", async () => {
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
          otherUsername: null,
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("no other member to target");
  });

  test("reads a direct message's sender from the message and its target from the other member", async () => {
    // The two are different values and must not be confused: the sender is the message's author,
    // while a DM's target is the conversation's *other* member — the one the Agent replies to.
    const db = {
      messageMention: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "handoff",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-author",
          deliveryId: "delivery-1",
          senderAgentName: null,
          senderAgentDescription: null,
          senderUsername: "author-agent",
          senderUserDescription: "",
          channelName: null,
          otherUsername: "recipient-agent",
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    const recovery = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );
    expect(recovery.resumeMessages).toEqual([
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 1,
        target: "@recipient-agent",
        latestSenderKind: "human",
        latestSenderHandle: "author-agent",
        latestSenderDescription: "",
        body: "handoff",
      },
    ]);
    expect(recovery.unreadSummary).toEqual({ "@recipient-agent": 1 });
  });

  test("fails closed rather than shipping a degraded sender when no name can be resolved", async () => {
    // ADR 0052 (decision B): an author row the database cannot produce (both `users.username`
    // and `agents.name` are NOT NULL) must fail with a named error rather than substitute
    // `"@agent"` or a bare `"@"` — the shape that previously poisoned daemon ready recovery.
    const db = {
      messageMention: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "handoff",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-author",
          deliveryId: "delivery-1",
          senderAgentName: null,
          senderAgentDescription: null,
          senderUsername: null,
          senderUserDescription: null,
          channelName: null,
          otherUsername: "recipient",
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("Agent message sender could not be resolved");
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
                sender: {
                  agentId: null,
                  agent: null,
                  user: { username: "alice", description: "" },
                },
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
        latestSenderKind: "human",
        latestSenderHandle: "alice",
        latestSenderDescription: "",
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
                agent: { name: "helper", description: "" },
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
        latestSenderKind: "agent",
        latestSenderHandle: "helper",
        latestSenderDescription: "",
        body: "@reviewer please review",
      },
    ]);
  });

  test("sendAgentMessage links two attachments in send order and rejects one the Agent did not upload", async () => {
    const updates: { where: unknown; data: unknown }[] = [];
    let attachmentQueries = 0;
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
        findMany: async ({
          where,
        }: {
          where: { id: { in: string[] }; uploaderAgentId: string; messageId: null };
        }) => {
          attachmentQueries += 1;
          return where.id.in.flatMap((id) => {
            const row = attachmentsById[id];
            if (!row || row.uploaderAgentId !== where.uploaderAgentId) return [];
            return [
              {
                id: row.id,
                fileName: row.fileName,
                contentType: row.contentType,
                sizeBytes: row.sizeBytes,
              },
            ];
          });
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
      agent: {
        findUnique: async () => ({ ownerId: "user-1", visibility: "public" }),
      },
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
          members: [
            {
              id: "member-agent",
              agentId: "agent-1",
              userId: null,
              agent: { name: "agent-1", description: "" },
            },
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
    expect(attachmentQueries).toBe(1);
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
    let attachmentQueries = 0;
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
        findMany: async ({ where }: { where: { id: { in: string[] }; uploaderId: string } }) => {
          attachmentQueries += 1;
          return where.id.in.flatMap((id) => {
            const row = attachmentsById[id];
            if (!row || where.uploaderId !== "user-1") return [];
            return [row];
          });
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
              agent: { name: "helper", computerId: null, ownerId: "user-1", visibility: "public" },
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
    expect(attachmentQueries).toBe(1);
    expect(updates).toEqual([
      { where: { id: "attach-b" }, data: { messageId: "message-new", position: 0 } },
      { where: { id: "attach-a" }, data: { messageId: "message-new", position: 1 } },
    ]);
  });

  test("sendMessage rejects a non-creator sending into a since-privatized DM (ADR 0059)", async () => {
    const db = {
      conversation: {
        findUnique: async () => ({
          workspaceId: "workspace-1",
          members: [
            { id: "member-user", userId: "user-2", agentId: null, user: { username: "bob" } },
            {
              id: "member-agent",
              userId: null,
              agentId: "agent-1",
              agent: {
                name: "helper",
                computerId: null,
                ownerId: "user-1",
                visibility: "private",
              },
            },
          ],
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      new PrismaDirectConversationRepository(db).sendMessage(
        "conversation-1",
        "member-user",
        "user-2",
        "hello",
      ),
    ).rejects.toMatchObject({ name: "AppError", code: "AGENT_DM_RESTRICTED" });
  });

  test("sendAgentMessage rejects a private Agent's own outbound DM to a non-creator (ADR 0059)", async () => {
    const db = {
      agent: {
        findUnique: async () => ({ ownerId: "user-1", visibility: "private" }),
      },
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
          members: [
            {
              id: "member-agent",
              agentId: "agent-1",
              userId: null,
              agent: { name: "agent-1", description: "" },
            },
            { id: "member-user", agentId: null, userId: "user-2" },
          ],
        }),
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
    } as unknown as PrismaClient;
    await expect(
      new PrismaDirectConversationRepository(db).sendAgentMessage(
        "conversation-1",
        "agent-1",
        "hello",
      ),
    ).rejects.toMatchObject({ name: "AgentSendRejectedError", status: 403 });
  });

  describe("getOrCreateUserAgent (ADR 0059)", () => {
    function fixture(options: { visibility: string; ownerId: string; existing?: { id: string } }) {
      const created: unknown[] = [];
      const db = {
        agent: {
          findFirst: async () => ({
            id: "agent-1",
            ownerId: options.ownerId,
            visibility: options.visibility,
          }),
        },
        conversation: {
          findUnique: async () => options.existing ?? null,
          create: async (input: { data: unknown }) => {
            created.push(input.data);
            return { id: "conversation-new" };
          },
        },
      } as unknown as PrismaClient;
      return { repository: new PrismaDirectConversationRepository(db), created };
    }

    test("a non-creator cannot start a brand-new DM with a private Agent", async () => {
      const { repository, created } = fixture({ visibility: "private", ownerId: "user-1" });
      await expect(
        repository.getOrCreateUserAgent("workspace-1", "user-2", "agent-1"),
      ).rejects.toMatchObject({ name: "AppError", code: "AGENT_DM_RESTRICTED" });
      expect(created).toEqual([]);
    });

    test("the creator can always start a DM with their own private Agent", async () => {
      const { repository, created } = fixture({ visibility: "private", ownerId: "user-1" });
      await repository.getOrCreateUserAgent("workspace-1", "user-1", "agent-1");
      expect(created).toHaveLength(1);
    });

    test("anyone can start a DM with a public Agent", async () => {
      const { repository, created } = fixture({ visibility: "public", ownerId: "user-1" });
      await repository.getOrCreateUserAgent("workspace-1", "user-2", "agent-1");
      expect(created).toHaveLength(1);
    });

    test("an existing DM with a since-privatized Agent stays open for reading, not creation", async () => {
      const { repository, created } = fixture({
        visibility: "private",
        ownerId: "user-1",
        existing: { id: "conversation-old" },
      });
      const conversation = await repository.getOrCreateUserAgent(
        "workspace-1",
        "user-2",
        "agent-1",
      );
      expect(conversation).toEqual({ id: "conversation-old" });
      expect(created).toEqual([]);
    });
  });

  describe("openForUser reports dmWritable (ADR 0059)", () => {
    function fixture(options: { visibility: string; ownerId: string; viewerId: string }) {
      const db = {
        conversation: {
          findUnique: async () => ({
            id: "conversation-1",
            workspaceId: "workspace-1",
            directKey: `agent:agent-1|user:${options.viewerId}`,
            members: [
              {
                id: "member-user",
                userId: options.viewerId,
                agentId: null,
                readThroughSequence: 0,
                threadReads: [],
                user: { username: "viewer" },
              },
              {
                id: "member-agent",
                userId: null,
                agentId: "agent-1",
                readThroughSequence: 0,
                threadReads: [],
                agent: {
                  id: "agent-1",
                  name: "helper",
                  displayName: "Helper",
                  deletedAt: null,
                  ownerId: options.ownerId,
                  visibility: options.visibility,
                },
              },
            ],
            messages: [],
          }),
        },
      } as unknown as PrismaClient;
      class TestConversationRepository extends PrismaDirectConversationRepository {
        override async getOrCreateUserAgent() {
          return { id: "conversation-1" };
        }
      }
      return new TestConversationRepository(db);
    }

    test("the creator can always send, public or private", async () => {
      const repository = fixture({ visibility: "private", ownerId: "user-1", viewerId: "user-1" });
      const page = await repository.openForUser("workspace-1", "user-1", "agent-1");
      expect(page.dmWritable).toBe(true);
    });

    test("a non-creator's existing DM with a private Agent reads read-only", async () => {
      const repository = fixture({ visibility: "private", ownerId: "user-1", viewerId: "user-2" });
      const page = await repository.openForUser("workspace-1", "user-2", "agent-1");
      expect(page.dmWritable).toBe(false);
    });

    test("a public Agent's DM is always writable", async () => {
      const repository = fixture({ visibility: "public", ownerId: "user-1", viewerId: "user-2" });
      const page = await repository.openForUser("workspace-1", "user-2", "agent-1");
      expect(page.dmWritable).toBe(true);
    });
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
