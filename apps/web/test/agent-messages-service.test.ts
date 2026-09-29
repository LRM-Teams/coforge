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
  type AgentTargetFreshness,
} from "#src/server/agents/agent-messages.server";

function repository(overrides: Partial<AgentMessageRepository> = {}): AgentMessageRepository {
  return {
    setAgentChannelMuted: async () => {},
    setAgentThreadFollowed: async () => {},
    ...overrides,
  };
}

/** A repository whose send target resolves to these freshness reads. */
function freshnessRepository(freshness: AgentTargetFreshness): AgentMessageRepository {
  return repository({ agentTargetFreshness: async () => freshness });
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
  expect(calls).toEqual([["workspace-1", "agent-1", 10, undefined]]);
  expect(result.hasMore).toBe(true);
  expect(result.messages[0]?.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("drain forwards an optional target to the repository", async () => {
  const calls: unknown[] = [];
  await drainAgentEvents(
    repository({
      drainAgentEvents: async (...args) => {
        calls.push(args);
        return { messages: [], hasMore: false };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    undefined,
    "@ada",
  );
  expect(calls).toEqual([["workspace-1", "agent-1", undefined, "@ada"]]);
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
        return { messages: [], hasOlder: true, hasNewer: false, modelSeenUpToSeq: null };
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
  expect(result).toEqual({ messages: [], hasOlder: true, hasNewer: false, modelSeenUpToSeq: null });
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
      idempotencyKey: "request-1",
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

test("send policy resolves the target once, then advances the read-through boundary before reading pending context", async () => {
  const calls: unknown[] = [];
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        agentTargetFreshness: async (...args) => {
          calls.push(["target", ...args]);
          return {
            advanceReadThrough: async (...advanceArgs) => {
              calls.push(["advance", ...advanceArgs]);
              return 5;
            },
            readPending: async (...pendingArgs) => {
              calls.push(["pending", ...pendingArgs]);
              return [];
            },
          };
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
    ["target", "workspace-1", "agent-a", "@user"],
    ["advance", 7],
    ["pending", 5, undefined],
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

/** A target's newest `rows` as the repository reports them: the window less what the Agent was
 * shown one by one, and the window's newest sequence. */
const recentContext =
  (rows: ReturnType<typeof pendingRow>[]) =>
  async (_limit: number, excluding?: readonly number[]) => ({
    unseen: rows.filter((row) => !(excluding ?? []).includes(row.sequence)),
    maxSequence: rows.length ? Math.max(...rows.map((row) => row.sequence)) : undefined,
  });

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
      repository: freshnessRepository({
        readPending: async (after) =>
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
      repository: freshnessRepository({
        advanceReadThrough: async () => 9,
        readPending: async (after) =>
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
    repository: freshnessRepository({ readPending: async () => [pendingRow(7, "first")] }),
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
      repository: freshnessRepository({
        readPending: async () => [],
        readRecent: recentContext([pendingRow(4, "recent context")]),
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
      repository: freshnessRepository({
        readPending: async () => [],
        readRecent: recentContext([]),
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
      repository: freshnessRepository({ readPending: async () => pending }),
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
      repository: freshnessRepository({
        // The inline window is bounded to three rows; the count is not.
        readPending: async () => [pendingRow(8, "third"), pendingRow(9, "fourth")],
        countPending: async () => 5,
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
  const send = (options: { seenUpToSeq?: number; readRecent?: ReturnType<typeof recentContext> }) =>
    executeAgentSendMessageWithPolicy(
      {
        repository: freshnessRepository({
          advanceReadThrough: async () => options.seenUpToSeq ?? 0,
          readPending: async () => [],
          ...(options.readRecent ? { readRecent: options.readRecent } : {}),
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
      repository: freshnessRepository({
        readPending: async (after) => {
          boundary = after;
          return [pendingRow(7, "SECRET")];
        },
        countPending: async () => 12,
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

test("send policy leaves out of its pending context the messages the Agent was shown one by one", async () => {
  const pending = [pendingRow(7, "checked"), pendingRow(9, "never shown")];
  const excluded: unknown[] = [];
  const freshness: AgentTargetFreshness = {
    advanceReadThrough: async () => 4,
    readPending: async (after, excluding) => {
      excluded.push(excluding);
      return pending.filter(
        (row) => row.sequence > (after ?? 0) && !(excluding ?? []).includes(row.sequence),
      );
    },
    countPending: async (after, excluding) =>
      pending.filter(
        (row) => row.sequence > (after ?? 0) && !(excluding ?? []).includes(row.sequence),
      ).length,
  };
  const dependencies = {
    repository: freshnessRepository(freshness),
    sender: { executeFromAgent: async () => ({ id: "message-10" }) },
  };

  // The repository, which knows each read's lower bound, drops what lies at or below it.
  const held = await executeAgentSendMessageWithPolicy(
    dependencies,
    sendInput({ seenUpToSeq: 4, seenExactSeqs: [2, 7] }),
  );
  expect(excluded[0]).toEqual([2, 7]);
  expect(held).toMatchObject({ state: "held", newMessageCount: 1, seenUpToSeq: 9 });
  expect(held.heldMessages?.map((message) => message.id)).toEqual(["message-9"]);

  const sent = await executeAgentSendMessageWithPolicy(
    dependencies,
    sendInput({ seenUpToSeq: 4, seenExactSeqs: [7, 9] }),
  );
  expect(sent).toMatchObject({ state: "sent", decision: "forward", messageId: "message-10" });

  // A withheld send presented nothing, but what the Agent saw one by one it still saw.
  const withheld = await executeAgentSendMessageWithPolicy(
    dependencies,
    sendInput({ seenUpToSeq: 4, seenExactSeqs: [7, 9], freshnessContextMode: "withheld" }),
  );
  expect(withheld).toMatchObject({ state: "sent" });
});

test("a first touch holds only on the recent context the Agent was not shown, presenting the window's newest boundary", async () => {
  const held = await executeAgentSendMessageWithPolicy(
    {
      repository: freshnessRepository({
        readPending: async () => [],
        readRecent: recentContext([
          pendingRow(3, "checked"),
          pendingRow(4, "not shown"),
          pendingRow(5, "checked"),
        ]),
      }),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
    sendInput({ seenExactSeqs: [3, 5] }),
  );
  // Raft's `planFirstTouchRecentContext`: the held context is the unconsumed messages, and its
  // `seenUpToSeq` is the whole recent window's newest (the consume boundary).
  expect(held).toMatchObject({
    state: "held",
    decision: "syncing_hold",
    reason: "target_first_touch_recent_context",
    newMessageCount: 1,
    shownMessageCount: 1,
    seenUpToSeq: 5,
  });
  expect(held.heldMessages?.map((message) => message.id)).toEqual(["message-4"]);
});

test("a first touch whose recent context the Agent was all shown forwards and advances the boundary over it", async () => {
  const advanced: number[] = [];
  const sent = await executeAgentSendMessageWithPolicy(
    {
      repository: freshnessRepository({
        advanceReadThrough: async (sequence) => {
          advanced.push(sequence);
          return sequence;
        },
        readPending: async () => [],
        readRecent: recentContext([pendingRow(4, "checked"), pendingRow(5, "checked")]),
      }),
      sender: { executeFromAgent: async () => ({ id: "message-6" }) },
    },
    sendInput({ seenExactSeqs: [4, 5] }),
  );
  expect(sent).toMatchObject({
    state: "sent",
    decision: "forward",
    reason: "target_first_touch_recent_context_already_seen",
    messageId: "message-6",
    seenUpToSeq: 5,
  });
  expect(advanced).toEqual([5]);
});

test("pending messages the Agent was all shown forward, advancing the boundary only when a known boundary reaches them", async () => {
  const pending = [pendingRow(6, "checked"), pendingRow(8, "checked")];
  const send = async (readThrough: number) => {
    const advanced: number[] = [];
    let pendingReads = 0;
    const result = await executeAgentSendMessageWithPolicy(
      {
        repository: freshnessRepository({
          advanceReadThrough: async (sequence) => {
            advanced.push(sequence);
            return Math.min(sequence, 8);
          },
          readThrough: async () => readThrough,
          readPending: async (after, excluding) => {
            pendingReads += 1;
            return pending.filter(
              (row) => row.sequence > (after ?? 0) && !(excluding ?? []).includes(row.sequence),
            );
          },
          // The pending maximum is one aggregate, not a second window read with its bodies.
          maxPendingSequence: async (after) =>
            Math.max(
              0,
              ...pending.filter((row) => row.sequence > (after ?? 0)).map((row) => row.sequence),
            ),
        }),
        sender: { executeFromAgent: async () => ({ id: "message-9" }) },
      },
      sendInput({ seenUpToSeq: 5, seenExactSeqs: [6, 8] }),
    );
    expect(pendingReads).toBe(1);
    return { result, advanced };
  };

  // The check that showed them moved the server's read-through past them: the boundary advances.
  const caughtUp = await send(8);
  expect(caughtUp.result).toMatchObject({
    state: "sent",
    decision: "forward",
    reason: "exact_target_pending_already_seen",
    seenUpToSeq: 8,
  });
  expect(caughtUp.advanced).toEqual([5, 8]);

  // Nothing known reaches message 8: the send goes, and no boundary moves.
  const behind = await send(5);
  expect(behind.result).toMatchObject({
    state: "sent",
    reason: "exact_target_pending_already_seen",
  });
  expect(behind.result.seenUpToSeq).toBeUndefined();
  expect(behind.advanced).toEqual([5]);
});

test("a withheld send still treats what lies at or below the reported boundary as seen", async () => {
  const boundaries: (number | undefined)[] = [];
  await executeAgentSendMessageWithPolicy(
    {
      repository: freshnessRepository({
        advanceReadThrough: async (sequence) => sequence,
        readPending: async (after) => {
          boundaries.push(after);
          return [];
        },
      }),
      sender: { executeFromAgent: async () => ({ id: "message-9" }) },
    },
    sendInput({ seenUpToSeq: 5, freshnessContextMode: "withheld" }),
  );
  // Raft's `isMessageModelSeen` does not depend on the mode.
  expect(boundaries).toEqual([5]);
});

test("a withheld send never loads first-touch context", async () => {
  let recentLoaded = false;
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: freshnessRepository({
        readPending: async () => [],
        readRecent: async (limit, excluding) => {
          recentLoaded = true;
          return recentContext([pendingRow(4, "recent")])(limit, excluding);
        },
      }),
      sender: { executeFromAgent: async () => ({ id: "message-5" }) },
    },
    sendInput({ freshnessContextMode: "withheld" }),
  );
  expect(result).toMatchObject({
    state: "sent",
    decision: "forward",
    reason: "no_exact_target_pending_or_recent_context",
  });
  expect(recentLoaded).toBe(false);
});
