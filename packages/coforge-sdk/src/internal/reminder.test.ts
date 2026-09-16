import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { AgentReminderOperationRequestSchema } from "./gen/coforge/rpc/v1/reminder_pb";
import {
  REMINDER_SYNC_MESSAGE_TYPE,
  decodeAgentReminderOperationRequest,
  decodeAgentReminderOperationResponse,
  decodeReminderFireResponse,
  decodeReminderSync,
  encodeAgentReminderOperationResponse,
  encodeAgentReminderOperationRequest,
  encodeLocalReminderRequest,
  encodeReminderFireResponse,
  encodeReminderSync,
  isReminderMessageAnchor,
} from "./index";

const scope = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
};
const reminderId = "018f47ac-7c56-7abc-8def-0123456789ab";
const fullTitle =
  "准备发布提醒：请核对 multilingual release notes、回滚步骤与负责人。\n\t第二行保留原始缩进，包含 العربية و日本語；第三部分继续记录完整提醒正文，不应截断为 Inbox preview。\r\n最后确认所有检查均已完成。";

test("preserves full multiline reminder titles across protocol seams", () => {
  expect(fullTitle.length).toBeGreaterThan(120);

  const schedule = {
    ...scope,
    operation: "schedule" as const,
    title: fullTitle,
    target: "#general",
    messageId: "deadbeef",
    delaySeconds: 900,
  };
  expect(
    decodeAgentReminderOperationRequest(encodeAgentReminderOperationRequest(schedule)),
  ).toEqual(schedule);

  const update = {
    ...scope,
    operation: "update" as const,
    reminderId,
    title: fullTitle,
  };
  expect(decodeAgentReminderOperationRequest(encodeAgentReminderOperationRequest(update))).toEqual(
    update,
  );

  const job = {
    reminderId,
    ownerAgentId: scope.agentId,
    version: 2,
    title: fullTitle,
    target: "@frank",
    messageId: reminderId,
    fireAt: "2026-09-08T10:00:00Z",
  };
  const sync = {
    ...scope,
    operation: "upsert" as const,
    jobs: [job],
    messageType: REMINDER_SYNC_MESSAGE_TYPE,
  };
  expect(decodeReminderSync(encodeReminderSync(sync))).toEqual(sync);

  const response = {
    ...scope,
    accepted: true,
    reminders: [
      {
        ...job,
        status: "scheduled" as const,
        createdAt: "2026-09-08T09:00:00Z",
      },
    ],
    events: [],
  };
  expect(
    decodeAgentReminderOperationResponse(encodeAgentReminderOperationResponse(response)),
  ).toEqual(response);
});

test("round-trips and validates cloud reminder operations", () => {
  const request = {
    ...scope,
    operation: "schedule" as const,
    title: "Review",
    target: "#general",
    messageId: "deadbeef",
    delaySeconds: 900,
    repeat: "every:15m",
    timezone: "UTC",
  };
  expect(decodeAgentReminderOperationRequest(encodeAgentReminderOperationRequest(request))).toEqual(
    request,
  );
  expect(() =>
    encodeAgentReminderOperationRequest({ ...request, delaySeconds: Number.NaN }),
  ).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({ ...request, fireAt: "2026-09-08T10:00:00Z" }),
  ).toThrow();
  expect(() => encodeAgentReminderOperationRequest({ ...request, messageId: "dead" })).toThrow();
  expect(() => encodeAgentReminderOperationRequest({ ...scope, operation: "cancel" })).toThrow();
  expect(isReminderMessageAnchor(reminderId)).toBe(true);
  expect(isReminderMessageAnchor("deadbeef")).toBe(true);
});

test("accepts established targets, bounded recurrence, and explicit instants", () => {
  const request = {
    ...scope,
    operation: "schedule" as const,
    title: "Review",
    target: `@frank:${reminderId}`,
    messageId: "deadbeef",
    repeat: "every:37m",
  };
  expect(() => encodeAgentReminderOperationRequest(request)).not.toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({
      ...request,
      target: "@frank:deadbeef",
      repeat: "every:3d",
    }),
  ).not.toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({ ...request, target: "@Frank.Name" }),
  ).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({ ...request, repeat: "every:999999999d" }),
  ).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({ ...request, repeat: undefined, fireAt: "2026-09-08" }),
  ).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({
      ...request,
      repeat: undefined,
      fireAt: "2026-09-08T10:00:00",
    }),
  ).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({
      ...request,
      repeat: undefined,
      fireAt: "2026-09-08T10:00:00+02:00",
    }),
  ).not.toThrow();
});

test("enforces operation-specific reminder fields", () => {
  const schedule = {
    ...scope,
    operation: "schedule" as const,
    title: "Review",
    target: "@frank",
    messageId: "deadbeef",
    repeat: "daily@10:00",
    timezone: "UTC",
  };
  expect(() => encodeAgentReminderOperationRequest(schedule)).not.toThrow();
  expect(() => encodeAgentReminderOperationRequest({ ...schedule, repeat: undefined })).toThrow();
  expect(() => encodeAgentReminderOperationRequest({ ...schedule, status: "scheduled" })).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({
      ...scope,
      operation: "update",
      reminderId,
      repeat: "none",
    }),
  ).not.toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({
      ...scope,
      operation: "update",
      reminderId,
      target: "@frank",
    }),
  ).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({ ...scope, operation: "cancel", reminderId, title: "No" }),
  ).toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({
      ...scope,
      operation: "list",
      status: "scheduled",
      all: true,
    }),
  ).not.toThrow();
  expect(() =>
    encodeAgentReminderOperationRequest({ ...schedule, title: "bad\u0000control" }),
  ).toThrow();
  expect(() => encodeAgentReminderOperationRequest({ ...schedule, title: " \t\r\n" })).toThrow();
});

test("rejects malformed explicit optional values when decoding", () => {
  const encoded = toBinary(
    AgentReminderOperationRequestSchema,
    create(AgentReminderOperationRequestSchema, { ...scope, operation: "list", status: "" }),
  );
  expect(() => decodeAgentReminderOperationRequest(encoded)).toThrow();
});

test("round-trips explicit reminder synchronization", () => {
  const sync = {
    ...scope,
    operation: "upsert" as const,
    jobs: [
      {
        reminderId,
        ownerAgentId: "agent-1",
        version: 2,
        title: "Review",
        target: "@frank",
        messageId: reminderId,
        fireAt: "2026-09-08T10:00:00Z",
      },
    ],
    messageType: REMINDER_SYNC_MESSAGE_TYPE,
  };
  expect(decodeReminderSync(encodeReminderSync(sync))).toEqual(sync);
  expect(() => encodeReminderSync({ ...sync, operation: "snapshot", jobs: [] })).not.toThrow();
  expect(() => encodeReminderSync({ ...sync, operation: "cancel", jobs: [] })).toThrow();
  expect(() => encodeReminderSync({ ...sync, agentId: "agent-2" })).toThrow();
  expect(() =>
    encodeReminderSync({ ...sync, operation: "snapshot", jobs: [sync.jobs[0]!, sync.jobs[0]!] }),
  ).toThrow();
  expect(() =>
    encodeReminderSync({ ...sync, jobs: [{ ...sync.jobs[0]!, target: "@frank:deadbeef" }] }),
  ).toThrow();
  expect(() =>
    encodeReminderSync({
      ...sync,
      operation: "cancel",
      jobs: [],
      reminderId: "deadbeef",
      version: 2,
    }),
  ).toThrow();
});

test("requires coherent fire response results", () => {
  const response = {
    ...scope,
    reminderId,
    version: 2,
    result: "premature" as const,
    fired: false,
    catchup: false,
    retryAfterMs: 500,
  };
  expect(decodeReminderFireResponse(encodeReminderFireResponse(response))).toEqual(response);
  expect(() =>
    encodeReminderFireResponse({
      ...response,
      result: "accepted",
      fired: false,
      retryAfterMs: undefined,
    }),
  ).not.toThrow();
  expect(() => encodeReminderFireResponse({ ...response, retryAfterMs: undefined })).toThrow();
  expect(() =>
    encodeReminderFireResponse({
      ...response,
      result: "obsolete",
      retryAfterMs: undefined,
      fired: true,
    }),
  ).toThrow();
  expect(() =>
    encodeReminderFireResponse({ ...response, result: "premature", catchup: true }),
  ).toThrow();
});

test("canonical responses and local receipts reject non-canonical business data", () => {
  expect(() =>
    encodeAgentReminderOperationResponse({
      ...scope,
      accepted: true,
      reminders: [
        {
          reminderId,
          ownerAgentId: scope.agentId,
          version: 1,
          title: "Review",
          target: "@frank:deadbeef",
          messageId: reminderId,
          fireAt: "2026-09-08T10:00:00Z",
          status: "scheduled",
          createdAt: "2026-09-08T09:00:00Z",
        },
      ],
      events: [],
    }),
  ).toThrow();
  expect(() =>
    encodeLocalReminderRequest({
      requestId: "request-1",
      context: "agent",
      operation: "ack",
      reminderId,
      revision: 1,
      title: "extraneous",
    }),
  ).toThrow();
});
