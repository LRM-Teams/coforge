import { describe, expect, test } from "bun:test";
import {
  decodeAgentReminderOperationResponse,
  decodeReminderSync,
  encodeAgentReminderOperationRequest,
  encodeReminderSync,
  type AgentReminderOperationRequest,
  type ReminderSummaryRecord,
} from "@coforge/protocol";
import { createAgentReminderMethod } from "../src/server/centrifugo/rpc-handler.server";
import {
  DEFAULT_REMINDER_TIMEZONE,
  Reminders,
  nextOccurrence,
  type ReminderRepository,
} from "../src/server/reminders/reminders.server";

test("interval recurrence preserves due-time cadence and skips missed periods", () => {
  expect(
    nextOccurrence(
      "every:15m",
      DEFAULT_REMINDER_TIMEZONE,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:47:00Z"),
    ).toISOString(),
  ).toBe("2026-01-01T01:00:00.000Z");
});

describe("wall-clock recurrence DST policy", () => {
  test("chooses the first instant in an overlap", () => {
    expect(
      nextOccurrence(
        "daily@01:30",
        "America/New_York",
        new Date("2026-10-31T00:00:00Z"),
        new Date("2026-11-01T04:00:00Z"),
      ).toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
  });

  test("does not choose the second fold after the first fold has passed", () => {
    expect(
      nextOccurrence(
        "daily@01:30",
        "America/New_York",
        new Date("2026-10-31T00:00:00Z"),
        new Date("2026-11-01T05:45:00Z"),
      ).toISOString(),
    ).toBe("2026-11-02T06:30:00.000Z");
  });

  test("supports weekly recurrence in a half-hour offset timezone", () => {
    expect(
      nextOccurrence(
        "weekly:mon@09:15",
        "Asia/Kolkata",
        new Date("2026-09-01T00:00:00Z"),
        new Date("2026-09-06T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-09-07T03:45:00.000Z");
  });

  test("skips a date whose local clock time does not exist", () => {
    expect(
      nextOccurrence(
        "daily@02:30",
        "America/New_York",
        new Date("2026-03-07T00:00:00Z"),
        new Date("2026-03-08T05:00:00Z"),
      ).toISOString(),
    ).toBe("2026-03-09T06:30:00.000Z");
  });

  test("weekly recurrence searches past a skipped DST-gap occurrence", () => {
    expect(
      nextOccurrence(
        "weekly:sun@02:30",
        "America/New_York",
        new Date("2026-03-01T07:30:00Z"),
        new Date("2026-03-01T07:30:00Z"),
      ).toISOString(),
    ).toBe("2026-03-15T06:30:00.000Z");
  });
});

test("Agent reminder RPC requires the authenticated Agent's exact operation scope", async () => {
  let executions = 0;
  const method = createAgentReminderMethod({
    execute: async (request: AgentReminderOperationRequest) => {
      executions += 1;
      return { ...request, accepted: true, reminders: [], events: [] };
    },
  } as unknown as Reminders);
  const request = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-b",
    operation: "list" as const,
  };
  const payload = encodeAgentReminderOperationRequest(request);
  const principal = {
    userId: "same-owner",
    workspaceId: request.workspaceId,
    computerId: request.computerId,
    agentId: "agent-a",
  };

  for (const mismatched of [
    principal,
    { ...principal, agentId: request.agentId, workspaceId: "workspace-b" },
    { ...principal, agentId: request.agentId, computerId: "computer-b" },
  ]) {
    const result = await method(payload, { principal: mismatched });
    expect(result).toBeInstanceOf(Uint8Array);
    if (!(result instanceof Uint8Array)) throw new Error("expected encoded reminder response");
    expect(decodeAgentReminderOperationResponse(result)).toMatchObject({
      accepted: false,
      reason: "reminder operation principal scope is not authorized",
    });
    expect(executions).toBe(0);
  }

  expect(
    await method(payload, { principal: { ...principal, agentId: request.agentId } }),
  ).toBeInstanceOf(Uint8Array);
  expect(executions).toBe(1);
});

test("schedule persists before best-effort publication and defaults recurring timezone", async () => {
  let stored: ReminderSummaryRecord | undefined;
  const repository = {
    authorize: async () => true,
    resolveAnchor: async () => ({
      messageId: "11111111-1111-4111-8111-111111111111",
      target: "@alice",
    }),
    countActive: async () => 0,
    create: async (_scope: unknown, _requestId: string, _fingerprint: string, input: any) =>
      (stored = {
        ...input,
        reminderId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    list: async () => [],
    get: async () => undefined,
    update: async () => {
      throw new Error();
    },
    events: async () => [],
    fire: async () => {
      throw new Error();
    },
  } as unknown as ReminderRepository;
  const reminders = new Reminders(
    repository,
    { supports: async () => true },
    async () => {
      throw new Error("offline");
    },
    () => new Date("2026-01-01T00:00:00Z"),
  );
  const response = await reminders.execute(
    {
      protocolMajor: 1,
      requestId: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      operation: "schedule",
      title: "Follow up",
      target: "@alice",
      messageId: "11111111",
      repeat: "daily@09:00",
    },
    "owner",
  );
  expect(response.accepted).toBe(true);
  expect(stored?.timezone).toBe("Asia/Shanghai");
});

test("snapshot is bounded canonical daemon state", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({
    reminderId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    ownerAgentId: "agent",
    computerId: "computer",
    version: 1,
    title: "Reminder",
    target: "@alice",
    messageId: "11111111-1111-4111-8111-111111111111",
    fireAt: "2026-01-01T01:00:00.000Z",
    status: "scheduled" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  const repository = {
    authorize: async () => true,
    list: async () => rows,
  } as unknown as ReminderRepository;
  const reminders = new Reminders(repository, { supports: async () => true }, async () => {});
  const sync = decodeReminderSync(
    await reminders.snapshot({
      requestId: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      userId: "owner",
    }),
  );
  expect(sync.jobs).toHaveLength(50);
});

test("update and snooze publish encodable upserts without operation-only fields", async () => {
  const current = {
    reminderId: "22222222-2222-4222-8222-222222222222",
    ownerAgentId: "agent",
    computerId: "computer",
    version: 1,
    title: "Before",
    target: "@alice",
    messageId: "11111111-1111-4111-8111-111111111111",
    fireAt: "2026-01-02T01:00:00.000Z",
    status: "scheduled" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const published: ReturnType<typeof decodeReminderSync>[] = [];
  const repository = {
    authorize: async () => true,
    get: async () => current,
    update: async (_scope: unknown, _requestId: string, _fingerprint: string, _id: string) => ({
      ...current,
      version: 2,
      title: "After",
    }),
  } as unknown as ReminderRepository;
  const reminders = new Reminders(repository, { supports: async () => true }, async (sync) => {
    published.push(decodeReminderSync(encodeReminderSync(sync)));
  });

  for (const operation of ["update", "snooze"] as const)
    await reminders.execute(
      {
        protocolMajor: 1,
        requestId: `${operation}-request`,
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        operation,
        reminderId: current.reminderId,
        ...(operation === "update" ? { title: "After" } : { delaySeconds: 60 }),
      },
      "owner",
    );

  expect(published.map((sync) => sync.jobs[0])).toEqual([
    expect.objectContaining({ version: 2, title: "After" }),
    expect.objectContaining({ version: 2, title: "After" }),
  ]);
});

test("successful recurring fire best-effort publishes the canonical advanced job", async () => {
  const advanced = {
    reminderId: "22222222-2222-4222-8222-222222222222",
    ownerAgentId: "agent",
    computerId: "computer",
    version: 2,
    title: "Follow up",
    target: "@alice",
    messageId: "11111111-1111-4111-8111-111111111111",
    fireAt: "2026-01-02T01:00:00.000Z",
    status: "scheduled" as const,
    repeat: "daily@09:00",
    timezone: "Asia/Shanghai",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const published: ReturnType<typeof decodeReminderSync>[] = [];
  const repository = {
    authorize: async () => true,
    fire: async (_scope: unknown, request: any) => ({
      result: { ...request, result: "accepted" as const, fired: true, catchup: false },
      nextReminder: advanced,
    }),
  } as unknown as ReminderRepository;
  const reminders = new Reminders(repository, { supports: async () => true }, async (sync) => {
    published.push(decodeReminderSync(encodeReminderSync(sync)));
  });
  await reminders.fire(
    {
      protocolMajor: 1,
      requestId: "fire-request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      reminderId: advanced.reminderId,
      version: 1,
      firedAtClient: "2026-01-01T01:00:00.000Z",
    },
    "owner",
  );
  expect(published).toHaveLength(1);
  expect(published[0]?.jobs[0]).toMatchObject({ version: 2, title: advanced.title });
});
