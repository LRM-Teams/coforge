import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  decodeTaskRequest,
  decodeTaskResponse,
  encodeTaskRequest,
  encodeTaskResponse,
} from "./index";
import { AgentMessageRecordSchema } from "./gen/coforge/rpc/v1/local_rpc_pb";
import { TaskRequestSchema, TaskResponseSchema } from "./gen/coforge/rpc/v1/task_pb";

test("Task claim preserves mixed singular and plural selector kinds through RPC", () => {
  const base = {
    protocolMajor: 1,
    requestId: "mixed",
    workspaceId: "workspace",
    agentId: "agent",
    operation: "claim" as const,
    target: "#general",
  };
  for (const selectors of [
    { number: 2, numbers: [2, 5], messageId: "deadbeef" },
    { number: 8, messageId: "aabbccdd", messageIds: ["aabbccdd", "11223344"] },
    { numbers: [3, 7], messageIds: ["55667788"] },
  ]) {
    const request = { ...base, ...selectors };
    expect(decodeTaskRequest(encodeTaskRequest(request))).toEqual(request);
  }
});

test("Task protobuf round-trips asymmetric command and result fields", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    operation: "update",
    target: "@ada",
    number: 7,
    status: "in_review",
    expectedRevision: 3,
    description: "Ready for review",
    freshnessContextMode: "withheld",
  } as const;
  expect(decodeTaskRequest(encodeTaskRequest(request))).toEqual(request);
  const response = {
    protocolMajor: 1,
    requestId: "request-1",
    tasks: [
      {
        messageId: "message-1",
        conversationId: "conversation-1",
        number: 7,
        title: "Ship it",
        status: "in_review" as const,
        revision: 4,
        owner: { memberId: "member-1", kind: "agent" as const, name: "builder" },
      },
    ],
  };
  expect(decodeTaskResponse(encodeTaskResponse(response))).toEqual(response);
});

test("Task codec rejects invalid operation, thread targets, and missing operation arguments", () => {
  const base = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    agentId: "agent",
    operation: "list",
    target: "#general",
  } as const;
  expect(() => encodeTaskRequest({ ...base, operation: "bogus" as "list" })).toThrow(
    "invalid Task request",
  );
  expect(() => encodeTaskRequest({ ...base, target: "#general:deadbeef" })).toThrow(
    "invalid Task target",
  );
  expect(() => encodeTaskRequest({ ...base, operation: "create" })).toThrow(
    "missing Task operation argument",
  );
  expect(() => encodeTaskRequest({ ...base, operation: "unclaim" })).toThrow(
    "missing Task operation argument",
  );
  expect(() => encodeTaskRequest({ ...base, operation: "unclaim", number: 2_147_483_648 })).toThrow(
    "invalid Task number",
  );
  expect(() =>
    encodeTaskRequest({
      ...base,
      operation: "update",
      number: 1,
      status: "done",
      expectedRevision: 2_147_483_648,
    }),
  ).toThrow("invalid Task revision");
});

test("Task response accepts an empty task list and rejects invalid external task views", () => {
  expect(
    decodeTaskResponse(
      toBinary(
        TaskResponseSchema,
        create(TaskResponseSchema, { protocolMajor: 1, requestId: "request", tasks: [] }),
      ),
    ),
  ).toEqual({ protocolMajor: 1, requestId: "request", tasks: [] });

  const task = {
    messageId: "message-1",
    conversationId: "conversation-1",
    number: 1,
    title: "Task",
    status: "todo",
    revision: 0,
  };
  const malformed = [
    { ...task, status: "unknown" },
    { ...task, messageId: "" },
    { ...task, conversationId: "" },
    { ...task, number: 0 },
    { ...task, number: 2_147_483_648 },
    { ...task, revision: 2_147_483_648 },
    { ...task, owner: { memberId: "member-1", kind: "robot", name: "Ada" } },
  ];
  for (const invalidTask of malformed) {
    const bytes = toBinary(
      TaskResponseSchema,
      create(TaskResponseSchema, {
        protocolMajor: 1,
        requestId: "request",
        tasks: [invalidTask],
      }),
    );
    expect(() => decodeTaskResponse(bytes)).toThrow("invalid Task response");
  }
});

test("Task request codec enforces operation-specific selectors, limits, and scalar types", () => {
  const base = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    agentId: "agent",
    target: "#general",
  } as const;
  const commands = [
    { ...base, operation: "list" as const, status: "all" as const },
    {
      ...base,
      operation: "create" as const,
      titles: ["one", "two"],
      description: null,
      createsResource: false,
    },
    { ...base, operation: "convert" as const, messageId: "message" },
    { ...base, operation: "claim" as const, number: 3, numbers: [3, 4] },
    {
      ...base,
      operation: "claim" as const,
      messageId: "message",
      messageIds: ["message", "other"],
    },
    { ...base, operation: "assign" as const, number: 3, assignee: null, expectedRevision: 2 },
    { ...base, operation: "amend" as const, number: 3, description: null },
    {
      ...base,
      operation: "receipt" as const,
      number: 3,
      receipt: {
        object: "bucket",
        purpose: "test",
        teardownOwner: "@builder",
        securityPrivacy: "private",
        expiry: "2026-10-01T12:00:00.000Z",
        runbook: "run",
        tracking: "ticket",
      },
    },
  ];
  for (const command of commands)
    expect(decodeTaskRequest(encodeTaskRequest(command))).toEqual(command);
  expect(() =>
    encodeTaskRequest({ ...base, operation: "claim", mine: true, target: undefined, number: 1 }),
  ).toThrow();
  expect(() =>
    encodeTaskRequest({ ...base, operation: "update", number: 1, status: "all" }),
  ).toThrow();
  expect(() =>
    encodeTaskRequest({
      ...base,
      operation: "create",
      title: " ",
      createsResource: "false" as unknown as boolean,
    }),
  ).toThrow();
  expect(() =>
    encodeTaskRequest({ ...base, operation: "create", title: "x".repeat(10_001) }),
  ).toThrow();
  expect(() =>
    encodeTaskRequest({
      ...base,
      operation: "create",
      title: "x",
      description: "x".repeat(50_001),
    }),
  ).toThrow();
  expect(() =>
    decodeTaskRequest(
      toBinary(
        TaskRequestSchema,
        create(TaskRequestSchema, { ...base, operation: "list", target: "#general", mine: true }),
      ),
    ),
  ).toThrow();
});

test("Task result preserves resource, claim conflict, and rich held-message metadata", () => {
  const receipt = {
    object: "bucket",
    purpose: "test",
    teardownOwner: "@builder",
    securityPrivacy: "private",
    expiry: "2026-10-01T12:00:00Z",
    runbook: "run",
    tracking: "ticket",
  };
  const response = {
    protocolMajor: 1,
    requestId: "request",
    tasks: [
      {
        messageId: "message",
        conversationId: "conversation",
        number: 1,
        title: "Task",
        description: null,
        status: "in_progress" as const,
        revision: 2,
        owner: null,
        channelRef: "#general",
        requiresResourceReceipt: true,
        resourceReceiptRecordedAt: null,
        resourceReceipt: receipt,
        claimedAt: "2026-09-10T10:00:00Z",
      },
    ],
    heldMessages: [
      {
        id: "held",
        sequence: 2,
        sender: "Ada",
        target: "#general",
        body: "body",
        createdAt: "2026-09-10T10:01:00Z",
        attachment: {
          id: "attachment",
          fileName: "a.txt",
          contentType: "text/plain",
          sizeBytes: 4,
        },
        task: {
          number: 1,
          status: "todo" as const,
          owner: { displayName: "Builder", handle: "@builder" },
        },
      },
    ],
    claimConflict: {
      kind: "claim_conflict" as const,
      conflictScope: "implementation_execution" as const,
      blockedActions: ["claim"],
      unblockedActionExamples: ["review"],
      currentAssignee: { type: "agent" as const, name: null },
      taskStatus: "in_progress" as const,
      claimedAt: "2026-09-10T10:00:00Z",
      observedAt: "2026-09-10T10:01:00Z",
    },
  };
  expect(decodeTaskResponse(encodeTaskResponse(response))).toEqual(response);
});

test("withheld Task responses are projected before encoding and after hostile protobuf decoding", () => {
  const sensitive = create(AgentMessageRecordSchema, {
    id: "SECRET",
    sequence: 1n,
    sender: "SECRET",
    target: "#general",
    body: "SECRET",
    createdAt: "2026-09-10T10:00:00Z",
  });
  const hostile = create(TaskResponseSchema, {
    protocolMajor: 1,
    requestId: "request",
    freshnessContextMode: "withheld",
    state: "held",
    withheldMessageCount: 9,
    tasks: [
      {
        messageId: "SECRET",
        conversationId: "SECRET",
        number: 1,
        title: "SECRET",
        status: "todo",
        revision: 0,
      },
    ],
    claims: [{ number: 1, success: true }],
    history: [
      {
        id: "SECRET",
        sequence: 1,
        eventType: "SECRET",
        actorKind: "user",
        createdAt: "2026-09-10T10:00:00Z",
      },
    ],
    heldMessages: [sensitive],
    newMessageCount: 8,
  });
  const projected = {
    protocolMajor: 1,
    requestId: "request",
    tasks: [],
    state: "held" as const,
    freshnessContextMode: "withheld" as const,
    withheldMessageCount: 9,
  };
  expect(decodeTaskResponse(toBinary(TaskResponseSchema, hostile))).toEqual(projected);
  expect(
    decodeTaskResponse(
      encodeTaskResponse({
        ...projected,
        tasks: hostile.tasks as never,
        claims: [{ number: 1, success: true }],
        heldMessages: [
          {
            id: "SECRET",
            sequence: 1,
            sender: "SECRET",
            target: "#general",
            body: "SECRET",
            createdAt: "2026-09-10T10:00:00Z",
          },
        ],
      }),
    ),
  ).toEqual(projected);
});

test("Task response rejects unknown enums and malformed receipts without leaking protobuf metadata", () => {
  const malformed = create(TaskResponseSchema, {
    protocolMajor: 1,
    requestId: "request",
    state: "unknown",
  });
  expect(() => decodeTaskResponse(toBinary(TaskResponseSchema, malformed))).toThrow(
    "invalid Task response",
  );
  expect(() =>
    encodeTaskResponse({
      protocolMajor: 1,
      requestId: "request",
      tasks: [
        {
          messageId: "message",
          conversationId: "conversation",
          number: 1,
          title: "Task",
          status: "todo",
          revision: 0,
          owner: null,
          resourceReceipt: {
            object: "",
            purpose: "p",
            teardownOwner: "builder",
            securityPrivacy: "s",
            expiry: "tomorrow",
            runbook: "r",
            tracking: "t",
          },
        },
      ],
    }),
  ).toThrow("invalid Task response");
});
