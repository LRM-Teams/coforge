import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  decodeTaskRequest,
  decodeTaskResponse,
  encodeTaskRequest,
  encodeTaskResponse,
} from "./index";
import { TaskResponseSchema } from "./gen/coforge/rpc/v1/task_pb";

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
  expect(() => encodeTaskRequest({ ...base, operation: "delete" as "list" })).toThrow(
    "invalid Task request",
  );
  expect(() => encodeTaskRequest({ ...base, target: "#general:deadbeef" })).toThrow(
    "invalid Task target",
  );
  expect(() => encodeTaskRequest({ ...base, operation: "create" })).toThrow(
    "missing Task operation argument",
  );
  expect(() => encodeTaskRequest({ ...base, operation: "unclaim", number: 1 })).toThrow(
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
