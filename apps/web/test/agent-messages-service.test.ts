import { expect, test } from "bun:test";
import {
  drainAgentEvents,
  muteAgentChannel,
  readAgentMessages,
  executeAgentSendMessageWithPolicy,
  reactToAgentMessage,
  resolveAgentMessage,
  searchAgentMessages,
  unfollowAgentThread,
  type AgentMessageRepository,
} from "../src/server/agents/agent-messages.service";

function repository(overrides: Partial<AgentMessageRepository> = {}): AgentMessageRepository {
  return {
    setAgentChannelMuted: async () => {},
    setAgentThreadFollowed: async () => {},
    ...overrides,
  };
}

test("channel actions preserve the authenticated scope", async () => {
  const calls: unknown[] = [];
  await muteAgentChannel(
    repository({
      setAgentChannelMuted: async (...args) => {
        calls.push(args);
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "#general",
    true,
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "#general", true]]);
});

test("thread unfollow rejects a channel without a thread", async () => {
  await expect(
    unfollowAgentThread(repository(), { workspaceId: "w", agentId: "a" }, "#general"),
  ).rejects.toThrow("channel thread target");
});

test("drain maps Date values and forwards the limit and hasMore flag", async () => {
  const calls: unknown[] = [];
  const result = await drainAgentEvents(
    repository({
      drainAgentEvents: async (...args) => {
        calls.push(args);
        return {
          messages: [
            {
              id: "message-1",
              sequence: 1,
              senderKind: "human" as const,
              senderHandle: "ada",
              senderDescription: "",
              target: "@ada",
              body: "hello",
              createdAt: new Date("2026-09-15T00:00:00.000Z"),
              attachments: [],
            },
          ],
          hasMore: true,
        };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    10,
  );
  expect(calls).toEqual([["workspace-1", "agent-1", 10]]);
  expect(result.hasMore).toBe(true);
  expect(result.messages[0]?.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("drain rejects when the repository does not support the events seam", async () => {
  await expect(drainAgentEvents(repository(), { workspaceId: "w", agentId: "a" })).rejects.toThrow(
    "Agent event drain is unavailable",
  );
});

test("search maps Date values at the application boundary", async () => {
  const result = await searchAgentMessages(
    repository({
      searchMessages: async () => [
        {
          id: "message-1",
          sequence: 1,
          senderKind: "agent" as const,
          senderHandle: "agent-1",
          senderDescription: "",
          target: "#general",
          body: "hello",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
          attachments: [],
        },
      ],
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { query: "hello" },
  );
  expect(result[0]?.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("read preserves the authenticated scope and page arguments", async () => {
  let received: unknown;
  const result = await readAgentMessages(
    repository({
      readMessagesPage: async (...args) => {
        received = args;
        return { messages: [], hasOlder: true, hasNewer: false };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "#general",
    { around: "message-1", limit: 10 },
  );
  expect(received).toEqual([
    "workspace-1",
    "agent-1",
    "#general",
    { around: "message-1", limit: 10 },
  ]);
  expect(result).toEqual({ messages: [], hasOlder: true, hasNewer: false });
});

test("send policy forwards a clean message to the sender", async () => {
  const calls: unknown[] = [];
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository(),
      sender: {
        executeFromAgent: async (input) => {
          calls.push(input);
          return { id: "message-1" };
        },
      },
    },
    {
      idempotencyKey: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      target: "#general",
      content: "hello",
    },
  );
  expect(calls).toMatchObject([
    {
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      target: "#general",
      body: "hello",
    },
  ]);
  expect(result).toMatchObject({
    state: "sent",
    decision: "forward",
    messageId: "message-1",
  });
});

test("send policy forwards multiple attachmentIds to the sender in order", async () => {
  const calls: unknown[] = [];
  const attachmentIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository(),
      sender: {
        executeFromAgent: async (input) => {
          calls.push(input);
          return { id: "message-1" };
        },
      },
    },
    {
      idempotencyKey: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      target: "#general",
      content: "hello",
      attachmentIds,
    },
  );
  expect((calls[0] as { attachmentIds?: string[] }).attachmentIds).toEqual(attachmentIds);
  expect(result).toMatchObject({
    state: "sent",
    decision: "forward",
    messageId: "message-1",
  });
});

test("resolve maps Date values at the application boundary", async () => {
  const calls: unknown[] = [];
  const result = await resolveAgentMessage(
    repository({
      resolveAgentMessage: async (...args) => {
        calls.push(args);
        return {
          id: "message-1",
          sequence: 1,
          senderKind: "human" as const,
          senderHandle: "ada",
          senderDescription: "",
          target: "#general",
          body: "hello",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
          attachments: [],
        };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "abcd1234",
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234"]]);
  expect(result.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("resolve without repository support fails clearly", async () => {
  await expect(
    resolveAgentMessage(repository(), { workspaceId: "w", agentId: "a" }, "abcd1234"),
  ).rejects.toThrow("Agent message resolve is unavailable");
});

test("react preserves the authenticated scope and reaction fields", async () => {
  const calls: unknown[] = [];
  const result = await reactToAgentMessage(
    repository({
      setAgentMessageReaction: async (...args) => {
        calls.push(args);
        return { messageId: "message-1" };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "abcd1234",
    "👍",
    true,
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234", "👍", true]]);
  expect(result).toEqual({ messageId: "message-1" });
});

test("react rejects an emoji with whitespace before reaching the repository", async () => {
  await expect(
    reactToAgentMessage(
      repository({ setAgentMessageReaction: async () => ({ messageId: "message-1" }) }),
      { workspaceId: "w", agentId: "a" },
      "abcd1234",
      "a b",
      true,
    ),
  ).rejects.toThrow("reaction emoji must be one to sixteen characters without whitespace");
});

test("react rejects an emoji longer than sixteen characters", async () => {
  await expect(
    reactToAgentMessage(
      repository({ setAgentMessageReaction: async () => ({ messageId: "message-1" }) }),
      { workspaceId: "w", agentId: "a" },
      "abcd1234",
      "x".repeat(17),
      true,
    ),
  ).rejects.toThrow("reaction emoji must be one to sixteen characters without whitespace");
});

test("send policy advances the read-through boundary before reading pending context", async () => {
  const calls: unknown[] = [];
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        advanceAgentReadThrough: async (...args) => {
          calls.push(args);
          return 5;
        },
        readPendingAgentContext: async (...args) => {
          calls.push(["pending", ...args]);
          return [];
        },
      }),
      sender: { executeFromAgent: async () => ({ id: "message-1" }) },
    },
    {
      idempotencyKey: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-a",
      target: "@user",
      content: "Hello",
      seenUpToSeq: 7,
    },
  );
  expect(calls).toEqual([
    ["workspace-1", "agent-a", "@user", 7],
    ["pending", "workspace-1", "agent-a", "@user", 5],
  ]);
  expect(result).toMatchObject({
    state: "sent",
    decision: "forward",
    messageId: "message-1",
  });
});

test("send policy fails closed when a trusted seen sequence cannot be advanced", async () => {
  await expect(
    executeAgentSendMessageWithPolicy(
      {
        repository: repository(),
        sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
      },
      {
        idempotencyKey: "request-1",
        workspaceId: "workspace-1",
        agentId: "agent-a",
        target: "@user",
        content: "Hello",
        seenUpToSeq: 7,
      },
    ),
  ).rejects.toThrow("advancement is unavailable");
});

function pendingRow(sequence: number, body: string) {
  return {
    id: `message-${sequence}`,
    sequence,
    senderKind: "human" as const,
    senderHandle: "ada",
    senderDescription: "",
    target: "@user",
    body,
    createdAt: new Date("2026-09-10T00:00:00Z"),
    attachments: [],
  };
}

const sendInput = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-a",
  target: "@user",
  content: "Hello",
  ...overrides,
});

test("send policy holds unseen pending context, then forwards once the Agent reports the boundary", async () => {
  const pending = [pendingRow(7, "first"), pendingRow(9, "second")];
  const held = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        readPendingAgentContext: async (_workspace, _agent, _target, after) =>
          after === undefined ? pending : pending.filter((row) => row.sequence > after),
      }),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
    sendInput(),
  );
  expect(held).toMatchObject({
    state: "held",
    decision: "local_hold",
    reason: "exact_target_pending",
    availableActions: ["check_messages", "send_draft", "send_anyway"],
    newMessageCount: 2,
    shownMessageCount: 2,
    omittedMessageCount: 0,
    seenUpToSeq: 9,
  });
  expect(held.heldMessages?.map((message) => message.id)).toEqual(["message-7", "message-9"]);
  // The first hold of a draft does not suggest `--anyway`.
  expect(held.continueAnywaySuggested).toBe(false);

  const sent = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        advanceAgentReadThrough: async () => 9,
        readPendingAgentContext: async (_workspace, _agent, _target, after) =>
          after === undefined ? pending : pending.filter((row) => row.sequence > after),
      }),
      sender: { executeFromAgent: async () => ({ id: "message-10" }) },
    },
    sendInput({ seenUpToSeq: 9 }),
  );
  expect(sent).toMatchObject({
    state: "sent",
    decision: "forward",
    reason: "model_seen_boundary",
    messageId: "message-10",
  });
});

test("send policy suggests --anyway only for a draft that has already been held", async () => {
  const dependencies = {
    repository: repository({ readPendingAgentContext: async () => [pendingRow(7, "first")] }),
    sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
  };
  expect(
    await executeAgentSendMessageWithPolicy(dependencies, sendInput({ draftReholdCount: 0 })),
  ).toMatchObject({ state: "held", continueAnywaySuggested: false });
  expect(
    await executeAgentSendMessageWithPolicy(dependencies, sendInput({ draftReholdCount: 1 })),
  ).toMatchObject({ state: "held", continueAnywaySuggested: true });
});

test("send policy holds a first touch of a target that already carries context", async () => {
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        readPendingAgentContext: async () => [],
        readRecentAgentContext: async () => [pendingRow(4, "recent context")],
      }),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
    sendInput(),
  );
  expect(result).toMatchObject({
    state: "held",
    decision: "syncing_hold",
    reason: "target_first_touch_recent_context",
    newMessageCount: 1,
    shownMessageCount: 1,
    omittedMessageCount: 0,
    seenUpToSeq: 4,
  });
});

test("send policy forwards a first touch of a target with no context at all", async () => {
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        readPendingAgentContext: async () => [],
        readRecentAgentContext: async () => [],
      }),
      sender: { executeFromAgent: async () => ({ id: "message-1" }) },
    },
    sendInput(),
  );
  expect(result).toMatchObject({
    state: "sent",
    decision: "forward",
    reason: "no_exact_target_pending_or_recent_context",
    messageId: "message-1",
  });
});

test("send policy bypasses a hold when the Agent sends anyway and returns what it skipped", async () => {
  const pending = [pendingRow(7, "missed while held")];
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({ readPendingAgentContext: async () => pending }),
      sender: { executeFromAgent: async () => ({ id: "message-8" }) },
    },
    sendInput({ continueAnyway: true }),
  );
  expect(result).toMatchObject({
    state: "sent",
    decision: "bypass",
    reason: "continue_anyway",
    messageId: "message-8",
  });
  expect(result.recentUnread?.map((message) => message.id)).toEqual(["message-7"]);
});

test("send policy reports the unbounded newer count, so omitted messages stay visible", async () => {
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        // The inline window is bounded to three rows; the count is not.
        readPendingAgentContext: async () => [pendingRow(8, "third"), pendingRow(9, "fourth")],
        countPendingAgentContext: async () => 5,
      }),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
    sendInput(),
  );
  expect(result).toMatchObject({
    state: "held",
    newMessageCount: 5,
    shownMessageCount: 2,
    omittedMessageCount: 3,
  });
});

test("every freshness decision names its own fact id", async () => {
  const send = (options: {
    seenUpToSeq?: number;
    readRecentAgentContext?: () => Promise<never[]>;
  }) =>
    executeAgentSendMessageWithPolicy(
      {
        repository: repository({
          advanceAgentReadThrough: async () => options.seenUpToSeq ?? 0,
          readPendingAgentContext: async () => [],
          ...(options.readRecentAgentContext
            ? { readRecentAgentContext: options.readRecentAgentContext }
            : {}),
        }),
        sender: { executeFromAgent: async () => ({ id: "message-1" }) },
      },
      sendInput(options.seenUpToSeq === undefined ? {} : { seenUpToSeq: options.seenUpToSeq }),
    );

  const withBoundary = await send({ seenUpToSeq: 5 });
  const withoutBoundary = await send({});
  // Raft's `buildApmFreshnessDecisionProducerFactId` hashes the full stable decision input.
  expect(withBoundary.producerFactId).toMatch(/^freshness_decision_fact:[0-9a-f]{64}$/);
  expect(withoutBoundary.producerFactId).toMatch(/^freshness_decision_fact:[0-9a-f]{64}$/);
  // Two different reasons must never collapse onto one fact id.
  expect(withBoundary.producerFactId).not.toBe(withoutBoundary.producerFactId);
});

test("send policy in withheld mode hides bodies and reports the repository's true pending count", async () => {
  let boundary: number | undefined | "unset" = "unset";
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        readPendingAgentContext: async (_workspace, _agent, _target, after) => {
          boundary = after;
          return [pendingRow(7, "SECRET")];
        },
        countPendingAgentContext: async () => 12,
      }),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
    sendInput({ freshnessContextMode: "withheld" }),
  );
  expect(result).toMatchObject({
    state: "held",
    decision: "local_hold",
    freshnessContextMode: "withheld",
    withheldMessageCount: 12,
    newMessageCount: 12,
    shownMessageCount: 0,
  });
  // Withheld mode never presented context, so it must not narrow to a presented boundary.
  expect(boundary).toBeUndefined();
  expect(result.heldMessages).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
