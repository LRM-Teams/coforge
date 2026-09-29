import { describe, expect, test } from "bun:test";
import { MEMORY_OFFER_REQUIRED_MESSAGE } from "@lrm/coforge-sdk/internal";
import { handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import { AppError } from "#src/lib/app-error";
import type { AgentMessageRecord } from "#src/server/agents/agent-messages.server";
import { AgentSendRejectedError } from "#src/server/conversations/agent-send-rejected-error.server";
import {
  MessageRequestInProgressError,
  type MessageRequestRecords,
  type MessageRequestScope,
} from "#src/server/conversations/message-request-idempotency.server";

const request = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** No request is recorded under any key: the state a send finds when nothing was sent before. */
const noRequestRecords: MessageRequestRecords = { find: async () => undefined };

/** A repository whose send target has these pending, unreviewed rows. */
const pendingRepository = (rows: readonly AgentMessageRecord[]) => ({
  agentTargetFreshness: async () => ({ readPending: async () => rows }),
});

test("takes Raft's idempotencyKey as the request's key, with structured mentions forwarded", async () => {
  const mentions = [
    { type: "user" as const, id: "11111111-1111-4111-8111-111111111111", name: "ada" },
  ];
  let receivedMentions: unknown;
  const result = await handleAgentMessagesPost(
    request({
      target: "@ada",
      content: "hello @ada",
      idempotencyKey: "idem-1",
      sendDraft: true,
      mentions,
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async (input: { mentions?: unknown }) => {
          receivedMentions = input.mentions;
          return { id: "sent-1" };
        },
      },
    },
  );
  expect(result.status).toBe(200);
  // Raft's `idempotencyKey` is the key this request is deduplicated by (task #58 ④), and the
  // response echoes it back as this route's own `idempotencyKey`.
  expect(await result.json()).toMatchObject({ idempotencyKey: "idem-1", state: "sent" });
  expect(receivedMentions).toEqual(mentions);
});

test("a sent message reports the mentions it did not reach: pending actions and unresolved handles", async () => {
  const result = await handleAgentMessagesPost(
    request({
      target: "#triage",
      content: "@bob @ghost look",
      idempotencyKey: "idem-m",
      sendDraft: true,
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => ({
          id: "sent-m",
          pendingMentionActions: [
            {
              resolutionId: "22222222-2222-4222-8222-222222222222",
              messageId: "sent-m",
              targetType: "user" as const,
              targetId: "33333333-3333-4333-8333-333333333333",
              targetHandle: "bob",
              targetLabel: "Bob",
              targetAvatarUrl: null,
              channelName: "triage",
              availableActions: [],
              expiresAt: new Date("2026-10-01T00:00:00Z"),
            },
          ],
          unresolvedMentionHandles: ["ghost"],
        }),
      },
    },
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    state: "sent",
    messageId: "sent-m",
    pendingMentionActions: [
      {
        resolutionId: "22222222-2222-4222-8222-222222222222",
        messageId: "sent-m",
        targetType: "user",
        targetHandle: "bob",
        targetAvatarUrl: null,
        reason: "not_member",
        availableActions: [],
        expiresAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    unresolvedMentionHandles: ["ghost"],
  });
});

test("tolerates Raft's declared `continue` field without inventing semantics for it", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", idempotencyKey: "idem-2", continue: true }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: pendingRepository([
        {
          id: "message-1",
          sequence: 1,
          senderKind: "human" as const,
          senderHandle: "bea",
          senderDescription: "",
          target: "@ada",
          body: "unreviewed",
          createdAt: new Date("2026-09-10T00:00:00Z"),
          attachments: [],
        },
      ]),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(200);
  // Raft's own CLI never sets `continue` (1.0.32) and its semantics are unverified, so it must not
  // behave as the force-send flag: the only bypass is `continueAnyway`.
  expect(await result.json()).toMatchObject({ idempotencyKey: "idem-2", state: "held" });
});

test("rejects an unsupported freshnessContextMode with 400", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", freshnessContextMode: "secret" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid freshnessContextMode" });
});

test("rejects a missing target or body with 400 before reading freshnessContextMode", async () => {
  const result = await handleAgentMessagesPost(
    request({ content: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
});

test("withheld hold response carries state and a count, never message bodies", async () => {
  // Reviewer isolation: a freshness hold in withheld mode must return only
  // state and a count, never message bodies, senders, or metadata.
  const pendingRows = [
    {
      id: "message-1",
      sequence: 1,
      senderKind: "human" as const,
      senderHandle: "reviewer",
      senderDescription: "",
      target: "@ada",
      body: "do not leak this body",
      createdAt: new Date("2026-09-10T00:00:00Z"),
      attachments: [],
    },
    {
      id: "message-2",
      sequence: 2,
      senderKind: "human" as const,
      senderHandle: "reviewer",
      senderDescription: "",
      target: "@ada",
      body: "nor this one",
      createdAt: new Date("2026-09-10T00:01:00Z"),
      attachments: [],
    },
  ];
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "reviewer send", freshnessContextMode: "withheld" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: pendingRepository(pendingRows),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toMatchObject({
    state: "held",
    heldMessages: [],
    freshnessContextMode: "withheld",
    withheldMessageCount: 2,
  });
  const raw = JSON.stringify(body);
  expect(raw).not.toContain("do not leak this body");
  expect(raw).not.toContain("nor this one");
  expect(raw).not.toContain("@reviewer");
});

test("inline hold response still carries the presented message bodies", async () => {
  const pendingRows = [
    {
      id: "message-1",
      sequence: 1,
      senderKind: "human" as const,
      senderHandle: "reviewer",
      senderDescription: "",
      target: "@ada",
      body: "shown inline",
      createdAt: new Date("2026-09-10T00:00:00Z"),
      attachments: [],
    },
  ];
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "reviewer send" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: pendingRepository(pendingRows),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toMatchObject({ state: "held" });
  expect(body.freshnessContextMode).toBeUndefined();
  expect(body.withheldMessageCount).toBeUndefined();
  expect(body.heldMessages).toEqual([
    {
      id: "message-1",
      sequence: 1,
      senderKind: "human" as const,
      senderHandle: "reviewer",
      senderDescription: "",
      target: "@ada",
      body: "shown inline",
      createdAt: "2026-09-10T00:00:00.000Z",
      attachments: [],
    },
  ]);
});

test("rejects a non-uuid entry in attachmentIds with 400", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", attachmentIds: ["not-a-uuid"] }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid attachmentIds" });
});

test("rejects attachmentIds with more than 10 entries with 400", async () => {
  const ids = Array.from(
    { length: 11 },
    (_, index) => `11111111-1111-4111-8111-11111111111${index.toString(16)}`,
  );
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", attachmentIds: ids }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid attachmentIds" });
});

test("rejects a duplicate id in attachmentIds with 400", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", attachmentIds: [id, id] }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid attachmentIds" });
});

test("accepts two distinct attachmentIds and forwards them in order to the sender", async () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  let received: unknown;
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", attachmentIds: ids }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async (input: { attachmentIds?: string[] }) => {
          received = input.attachmentIds;
          return { id: "sent-1" };
        },
      },
    },
  );
  expect(result.status).toBe(200);
  expect(received).toEqual(ids);
});

test("rejects seenExactSeqs that are not positive integers within Raft's 2500 limit with 400", async () => {
  for (const seenExactSeqs of [
    [0],
    [1.5],
    "7",
    // Past the int4 `sequence` column: refused here, not failed in the database.
    [2_147_483_648],
    Array.from({ length: 2501 }, (_, index) => index + 1),
  ]) {
    const result = await handleAgentMessagesPost(
      request({ target: "@ada", content: "hello", seenExactSeqs }),
      { workspaceId: "workspace-1", agentId: "agent-1" },
      {
        requestRecords: noRequestRecords,
        repository: {},
        sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
      },
    );
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "invalid seenExactSeqs" });
  }
});

test("a send whose unreviewed messages the Agent was all shown one by one is not held", async () => {
  const pending = [7, 9].map((sequence) => ({
    id: `message-${sequence}`,
    sequence,
    senderKind: "human" as const,
    senderHandle: "ada",
    senderDescription: "",
    target: "@ada",
    body: "seen through a check",
    createdAt: new Date("2026-09-29T00:00:00Z"),
    attachments: [],
  }));
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", seenUpToSeq: 4, seenExactSeqs: [7, 9] }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {
        agentTargetFreshness: async () => ({
          advanceReadThrough: async (sequence: number) => sequence,
          readPending: async (after?: number, excluding?: readonly number[]) =>
            pending.filter(
              (row) => row.sequence > (after ?? 0) && !(excluding ?? []).includes(row.sequence),
            ),
        }),
      },
      sender: { executeFromAgent: async () => ({ id: "sent-1" }) },
    },
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ state: "sent", decision: "forward" });
});

test("a sent response carries the boundary the server advanced over messages the Agent had seen", async () => {
  const pending = [6, 8].map((sequence) => ({
    id: `message-${sequence}`,
    sequence,
    senderKind: "human" as const,
    senderHandle: "ada",
    senderDescription: "",
    target: "@ada",
    body: "seen through a check",
    createdAt: new Date("2026-09-29T00:00:00Z"),
    attachments: [],
  }));
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", seenUpToSeq: 5, seenExactSeqs: [6, 8] }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {
        agentTargetFreshness: async () => ({
          advanceReadThrough: async (sequence: number) => sequence,
          readThrough: async () => 8,
          readPending: async (after?: number, excluding?: readonly number[]) =>
            pending.filter(
              (row) => row.sequence > (after ?? 0) && !(excluding ?? []).includes(row.sequence),
            ),
          maxPendingSequence: async () => 8,
        }),
      },
      sender: { executeFromAgent: async () => ({ id: "sent-1" }) },
    },
  );
  expect(await result.json()).toMatchObject({
    state: "sent",
    reason: "exact_target_pending_already_seen",
    seenUpToSeq: 8,
  });
});

test("rejects malformed mentions with 400", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello @Ada", mentions: [{ type: "human", id: "x" }] }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid mentions" });
});

test("maps an AgentSendRejectedError from the sender to its own status and message", async () => {
  const result = await handleAgentMessagesPost(
    request({
      target: "@ada",
      content: "hello",
      attachmentIds: ["11111111-1111-4111-8111-111111111111"],
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AgentSendRejectedError(403, "attachment is not available for this message");
        },
      },
    },
  );
  expect(result.status).toBe(403);
  expect(await result.json()).toEqual({ error: "attachment is not available for this message" });
});

test("maps an AgentSendRejectedError naming the offending mention to a 400", async () => {
  const result = await handleAgentMessagesPost(
    request({
      target: "@ada",
      content: "hello @ghost",
      mentions: [{ type: "user", id: "11111111-1111-4111-8111-111111111111", name: "ghost" }],
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AgentSendRejectedError(
            400,
            "mention binding does not match a conversation member: @ghost",
          );
        },
      },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({
    error: "mention binding does not match a conversation member: @ghost",
  });
});

test("a channel ACCESS_DENIED AppError from channel resolution is not reported as an attachment error", async () => {
  // getAgentChannel throws AppError("ACCESS_DENIED") when the Agent is not a channel member; this
  // must never be mistaken for AgentSendRejectedError's attachment-unavailable case (the bug this
  // test guards against), and must propagate unchanged rather than becoming a Response.
  const caught = await handleAgentMessagesPost(
    request({ target: "#general", content: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AppError("ACCESS_DENIED");
        },
      },
    },
  ).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toContain("attachment");
});

test("a malformed-channel INVALID_INPUT AppError is not reported as a mention error", async () => {
  const caught = await handleAgentMessagesPost(
    request({ target: "#general", content: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AppError("INVALID_INPUT");
        },
      },
    },
  ).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toContain("mention binding");
});

test("a bypassed hold's sent response carries recentUnread; every other response carries none", async () => {
  const dependencies = {
    requestRecords: noRequestRecords,
    repository: pendingRepository([
      {
        id: "message-1",
        sequence: 1,
        senderKind: "human" as const,
        senderHandle: "bea",
        senderDescription: "",
        target: "@ada",
        body: "missed while held",
        createdAt: new Date("2026-09-10T00:00:00Z"),
        attachments: [],
      },
    ]),
    sender: { executeFromAgent: async () => ({ id: "sent-1" }) },
  };
  const firstHeld = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    dependencies,
  );
  const firstBody = await firstHeld.json();
  expect(firstBody.state).toBe("held");
  expect(firstBody.decision).toBe("local_hold");
  // The first hold of a draft does not suggest `--anyway`; a re-held one does (Raft's rule).
  expect(firstBody.continueAnywaySuggested).toBe(false);
  expect(firstBody.recentUnread).toEqual([]);

  const secondHeld = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", sendDraft: true, draftReholdCount: 1 }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    dependencies,
  );
  const secondBody = await secondHeld.json();
  expect(secondBody.state).toBe("held");
  expect(secondBody.continueAnywaySuggested).toBe(true);

  const bypassed = await handleAgentMessagesPost(
    request({
      target: "@ada",
      content: "hello",
      sendDraft: true,
      draftReholdCount: 1,
      continueAnyway: true,
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    dependencies,
  );
  expect(bypassed.status).toBe(200);
  const bypassedBody = await bypassed.json();
  expect(bypassedBody.state).toBe("sent");
  expect(bypassedBody.recentUnread).toEqual([
    {
      id: "message-1",
      sequence: 1,
      senderKind: "human" as const,
      senderHandle: "bea",
      senderDescription: "",
      target: "@ada",
      body: "missed while held",
      createdAt: "2026-09-10T00:00:00.000Z",
      attachments: [],
    },
  ]);
});

test("a channel send is refused while an explicit @memory question is unanswered", async () => {
  let sent = false;
  const result = await handleAgentMessagesPost(
    request({ target: "#general", content: "from memory" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      memoryOfferRequired: async () => true,
      sender: {
        executeFromAgent: async () => {
          sent = true;
          return { id: "should-not-send" };
        },
      },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe(MEMORY_OFFER_REQUIRED_MESSAGE);
  expect(sent).toBe(false);
});

describe("reconcileOnly: whether an idempotency key already committed, without sending", () => {
  const reconcile = (records: MessageRequestRecords) => {
    const sent: unknown[] = [];
    const freshnessReads: unknown[] = [];
    const response = handleAgentMessagesPost(
      request({ target: "@ada", idempotencyKey: "idem-lost", reconcileOnly: true }),
      { workspaceId: "workspace-1", agentId: "agent-1" },
      {
        requestRecords: records,
        repository: {
          agentTargetFreshness: async (...args: unknown[]) => {
            freshnessReads.push(args);
            return { readPending: async () => [] };
          },
        },
        sender: {
          executeFromAgent: async (input: unknown) => {
            sent.push(input);
            return { id: "never" };
          },
        },
      },
    );
    return { response, sent, freshnessReads };
  };

  test("a committed key answers its message id, with no receipt, and sends nothing", async () => {
    const scopes: MessageRequestScope[] = [];
    const { response, sent, freshnessReads } = reconcile({
      find: async (scope) => {
        scopes.push(scope);
        return {
          state: "completed",
          message: {
            id: "message-7",
            body: "hello",
            createdAt: new Date("2026-09-28T00:00:00Z"),
            sequence: 7,
            threadRootId: null,
            attachments: [],
            workspaceId: "workspace-1",
            agentId: "agent-1",
          },
        };
      },
    });
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      idempotencyKey: "idem-lost",
      state: "committed",
      reconciliation: true,
      receiptComplete: false,
      messageId: "message-7",
    });
    // The same scope `executeFromAgent` records a send under.
    expect(scopes).toEqual([
      {
        workspaceId: "workspace-1",
        senderKind: "agent",
        senderId: "agent-1",
        requestId: "idem-lost",
      },
    ]);
    expect(sent).toEqual([]);
    expect(freshnessReads).toEqual([]);
  });

  test("an unknown key answers not_found and sends nothing", async () => {
    const { response, sent, freshnessReads } = reconcile(noRequestRecords);
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      idempotencyKey: "idem-lost",
      state: "not_found",
      reconciliation: true,
    });
    expect(sent).toEqual([]);
    expect(freshnessReads).toEqual([]);
  });

  test("a key whose send is still processing answers 409, as a duplicate send does", async () => {
    const { response, sent } = reconcile({ find: async () => ({ state: "processing" }) });
    const result = await response;
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      error: "message request is already processing; retry later",
      code: "MESSAGE_REQUEST_IN_PROGRESS",
      retryable: true,
    });
    expect(sent).toEqual([]);
  });

  test("reconcileOnly: false is an ordinary send", async () => {
    const result = await handleAgentMessagesPost(
      request({
        target: "@ada",
        content: "hello",
        idempotencyKey: "idem-plain",
        reconcileOnly: false,
      }),
      { workspaceId: "workspace-1", agentId: "agent-1" },
      {
        requestRecords: noRequestRecords,
        repository: {},
        sender: { executeFromAgent: async () => ({ id: "sent-plain" }) },
      },
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ state: "sent", messageId: "sent-plain" });
  });

  test("needs the target and the key, and no content", async () => {
    for (const body of [
      { target: "@ada", reconcileOnly: true },
      { idempotencyKey: "idem-lost", reconcileOnly: true },
      { target: "@ada", idempotencyKey: "idem-lost", reconcileOnly: "yes" },
    ]) {
      const result = await handleAgentMessagesPost(
        request(body),
        { workspaceId: "workspace-1", agentId: "agent-1" },
        {
          requestRecords: noRequestRecords,
          repository: {},
          sender: { executeFromAgent: async () => ({ id: "never" }) },
        },
      );
      expect(result.status).toBe(400);
    }
  });
});

test("a send whose key is still processing answers 409 instead of failing the request", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", idempotencyKey: "idem-busy" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new MessageRequestInProgressError();
        },
      },
    },
  );
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({
    error: "message request is already processing; retry later",
    code: "MESSAGE_REQUEST_IN_PROGRESS",
    retryable: true,
  });
});

test("a private Agent's reply in a direct message it may only read names AGENT_DM_RESTRICTED", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", content: "hello", idempotencyKey: "idem-restricted" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AppError("AGENT_DM_RESTRICTED");
        },
      },
    },
  );
  expect(result.status).toBe(403);
  expect(await result.json()).toEqual({
    error: "this direct message is private and read-only for this Agent",
    code: "AGENT_DM_RESTRICTED",
    retryable: false,
  });
});
