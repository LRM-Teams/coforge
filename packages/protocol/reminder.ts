import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentReminderOperationRequestSchema,
  AgentReminderOperationResponseSchema,
  LocalReminderRequestSchema,
  ReminderFireRequestSchema,
  ReminderFireResponseSchema,
  ReminderSnapshotRequestSchema,
  ReminderSyncSchema,
} from "./gen/coforge/rpc/v1/reminder_pb";

export const AGENT_REMINDER_METHOD = "agent:reminder" as const;
export const REMINDER_FIRE_METHOD = "reminder:fire" as const;
export const REMINDER_SNAPSHOT_METHOD = "reminder:snapshot" as const;
export const REMINDER_SYNC_MESSAGE_TYPE = "coforge.rpc.v1.ReminderSync" as const;
export const REMINDER_CAPABILITY = "reminder:v1" as const;

const MAX_BYTES = 65_536;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = /^[0-9a-f]{8}$/i;
const USERNAME = "[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?";
const HEX = "[0-9a-fA-F]";
const UUID_BODY = `${HEX}{8}-${HEX}{4}-[1-8]${HEX}{3}-[89abAB]${HEX}{3}-${HEX}{12}`;
const TARGET = new RegExp(
  `^(?:#[a-z0-9][a-z0-9_-]{0,31}|@${USERNAME}(?::(?:${HEX}{8}|${UUID_BODY}))?)$`,
);
const CANONICAL_TARGET = new RegExp(
  `^(?:#[a-z0-9][a-z0-9_-]{0,31}|@${USERNAME}(?::${UUID_BODY})?)$`,
);
const RECURRENCE =
  /^(?:every:[1-9]\d*[mhd]|daily@(?:[01]\d|2[0-3]):[0-5]\d|weekly:(?:mon|tue|wed|thu|fri|sat|sun)(?:,(?:mon|tue|wed|thu|fri|sat|sun))*@(?:[01]\d|2[0-3]):[0-5]\d)$/;
const OPERATIONS = ["schedule", "list", "update", "snooze", "cancel", "log"] as const;

export type ReminderOperation = (typeof OPERATIONS)[number];
export type ReminderScope = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
};
export type ReminderOperationFields = {
  reminderId?: string;
  title?: string;
  messageId?: string;
  target?: string;
  fireAt?: string;
  delaySeconds?: number;
  repeat?: string;
  timezone?: string;
  status?: "scheduled" | "fired" | "canceled";
  all?: boolean;
};
export type AgentReminderOperationRequest = ReminderScope &
  ReminderOperationFields & { operation: ReminderOperation };
export type ReminderSummaryRecord = {
  reminderId: string;
  ownerAgentId: string;
  version: number;
  title: string;
  target: string;
  messageId: string;
  fireAt: string;
  status: "scheduled" | "fired" | "canceled";
  repeat?: string;
  timezone?: string;
  createdAt: string;
  firedAt?: string;
};
export type ReminderLogEvent = { eventId: string; type: string; time: string; nextFireAt?: string };
export type AgentReminderOperationResponse = ReminderScope & {
  accepted: boolean;
  reason?: string;
  reminders: ReminderSummaryRecord[];
  events: ReminderLogEvent[];
};
export type ReminderJob = {
  reminderId: string;
  ownerAgentId: string;
  version: number;
  title: string;
  target: string;
  messageId: string;
  fireAt: string;
};
export type ReminderSync = ReminderScope & {
  operation: "snapshot" | "upsert" | "cancel";
  jobs: ReminderJob[];
  reminderId?: string;
  version?: number;
  messageType: typeof REMINDER_SYNC_MESSAGE_TYPE;
};
export type ReminderFireRequest = ReminderScope & {
  reminderId: string;
  version: number;
  firedAtClient: string;
};
export type ReminderFireResponse = ReminderScope & {
  reminderId: string;
  version: number;
  result: "accepted" | "premature" | "obsolete";
  fired: boolean;
  catchup: boolean;
  retryAfterMs?: number;
  reason?: string;
};
export type ReminderSnapshotRequest = ReminderScope;
export type LocalReminderRequest = ReminderOperationFields & {
  requestId: string;
  context: string;
  operation: ReminderOperation | "ack" | "dismiss";
  revision?: number;
};

export const isReminderId = (value: string): boolean => UUID.test(value);
export const isReminderMessageAnchor = (value: string): boolean =>
  UUID.test(value) || PREFIX.test(value);

function bounded(bytes: Uint8Array) {
  if (bytes.length > MAX_BYTES) throw new Error("Reminder payload too large");
  return bytes;
}
function positive(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff))
    throw new Error(`invalid ${field}`);
  return value;
}
function instant(value: string | undefined, field: string): string | undefined {
  if (
    value !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value)))
  )
    throw new Error(`invalid ${field}`);
  return value;
}
function scope<T extends ReminderScope>(value: T): T {
  if (
    value.protocolMajor !== 1 ||
    [value.requestId, value.workspaceId, value.computerId, value.agentId].some((v) => !ID.test(v))
  )
    throw new Error("invalid reminder scope");
  return value;
}
function fields<T extends ReminderOperationFields>(value: T, canonicalTarget = false): T {
  if (value.reminderId !== undefined && !isReminderId(value.reminderId))
    throw new Error("invalid reminder ID; full UUID required");
  if (value.messageId !== undefined && !isReminderMessageAnchor(value.messageId))
    throw new Error("invalid message anchor; use eight hexadecimal characters or a full UUID");
  if (
    value.target !== undefined &&
    !(canonicalTarget ? CANONICAL_TARGET : TARGET).test(value.target)
  )
    throw new Error("invalid reminder target");
  if (
    value.title !== undefined &&
    (!value.title.trim() || value.title.length > 120 || /[\u0000-\u001f\u007f]/.test(value.title))
  )
    throw new Error("invalid reminder title");
  positive(value.delaySeconds, "reminder delay");
  instant(value.fireAt, "reminder fire time");
  if (value.repeat !== undefined && value.repeat !== "none") {
    if (!RECURRENCE.test(value.repeat)) throw new Error("invalid reminder recurrence");
    const every = /^every:(\d+)([mhd])$/.exec(value.repeat);
    if (every) {
      const seconds = Number(every[1]) * ({ m: 60, h: 3600, d: 86400 }[every[2]!] ?? 0);
      if (!Number.isSafeInteger(seconds) || seconds > 0xffffffff)
        throw new Error("invalid reminder recurrence");
    }
  }
  if (value.timezone !== undefined && (!value.timezone || value.timezone.length > 100))
    throw new Error("invalid reminder timezone");
  if (value.status !== undefined && !["scheduled", "fired", "canceled"].includes(value.status))
    throw new Error("invalid reminder status");
  return value;
}
function operation<T extends AgentReminderOperationRequest>(value: T): T {
  scope(value);
  fields(value);
  if (!OPERATIONS.includes(value.operation)) throw new Error("invalid reminder operation");
  const present = (name: keyof ReminderOperationFields) => value[name] !== undefined;
  const allowed: Record<ReminderOperation, readonly (keyof ReminderOperationFields)[]> = {
    list: ["status", "all"],
    schedule: ["title", "target", "messageId", "fireAt", "delaySeconds", "repeat", "timezone"],
    update: ["reminderId", "title", "fireAt", "delaySeconds", "repeat", "timezone"],
    snooze: ["reminderId", "delaySeconds", "fireAt"],
    cancel: ["reminderId"],
    log: ["reminderId"],
  };
  const names = [
    "reminderId",
    "title",
    "messageId",
    "target",
    "fireAt",
    "delaySeconds",
    "repeat",
    "timezone",
    "status",
    "all",
  ] as const;
  if (names.some((name) => present(name) && !allowed[value.operation].includes(name)))
    throw new Error(`unexpected field for reminder ${value.operation}`);
  const timed = Number(present("fireAt")) + Number(present("delaySeconds"));
  if (
    value.operation === "schedule" &&
    (!value.title ||
      !value.target ||
      !value.messageId ||
      timed > 1 ||
      (!value.repeat && timed !== 1) ||
      value.repeat === "none" ||
      Boolean(value.timezone && !value.repeat))
  )
    throw new Error("invalid schedule reminder request");
  if (["cancel", "log"].includes(value.operation) && !value.reminderId)
    throw new Error("reminder ID required");
  if (value.operation === "snooze" && (!value.reminderId || timed !== 1))
    throw new Error("invalid snooze reminder request");
  if (
    value.operation === "update" &&
    (!value.reminderId ||
      timed > 1 ||
      ![value.title, value.fireAt, value.repeat, value.timezone].some((v) => v !== undefined))
  )
    throw new Error("invalid update reminder request");
  return value;
}
const optional = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([key, v]) => key !== "$typeName" && v !== undefined),
  );

export function encodeAgentReminderOperationRequest(value: AgentReminderOperationRequest) {
  return bounded(
    toBinary(
      AgentReminderOperationRequestSchema,
      create(AgentReminderOperationRequestSchema, operation(value)),
    ),
  );
}
export function decodeAgentReminderOperationRequest(
  bytes: Uint8Array,
): AgentReminderOperationRequest {
  const v = fromBinary(AgentReminderOperationRequestSchema, bounded(bytes));
  return operation(optional(v) as AgentReminderOperationRequest);
}

function summary(value: ReminderSummaryRecord): ReminderSummaryRecord {
  fields(value, true);
  if (
    !isReminderId(value.reminderId) ||
    !ID.test(value.ownerAgentId) ||
    !positive(value.version, "reminder version") ||
    !value.title ||
    !value.target ||
    !value.messageId ||
    !instant(value.fireAt, "reminder fire time") ||
    !instant(value.createdAt, "reminder created time") ||
    value.repeat === "none" ||
    (value.firedAt !== undefined && !instant(value.firedAt, "reminder fired time"))
  )
    throw new Error("invalid reminder summary");
  return value;
}
function event(value: ReminderLogEvent): ReminderLogEvent {
  if (
    !ID.test(value.eventId) ||
    !ID.test(value.type) ||
    !instant(value.time, "reminder event time") ||
    (value.nextFireAt !== undefined && !instant(value.nextFireAt, "next reminder fire time"))
  )
    throw new Error("invalid reminder event");
  return value;
}
function response(value: AgentReminderOperationResponse) {
  scope(value);
  value.reminders.forEach(summary);
  value.events.forEach(event);
  return value;
}
export function encodeAgentReminderOperationResponse(value: AgentReminderOperationResponse) {
  return bounded(
    toBinary(
      AgentReminderOperationResponseSchema,
      create(AgentReminderOperationResponseSchema, response(value)),
    ),
  );
}
export function decodeAgentReminderOperationResponse(
  bytes: Uint8Array,
): AgentReminderOperationResponse {
  const v = fromBinary(AgentReminderOperationResponseSchema, bounded(bytes));
  return response({
    ...optional(v),
    reason: v.reason,
    reminders: v.reminders.map((r) => summary(optional(r) as ReminderSummaryRecord)),
    events: v.events.map((e) => event(optional(e) as ReminderLogEvent)),
  } as AgentReminderOperationResponse);
}

function job(value: ReminderJob): ReminderJob {
  fields(value, true);
  if (
    !isReminderId(value.reminderId) ||
    !ID.test(value.ownerAgentId) ||
    !positive(value.version, "reminder version") ||
    !value.title ||
    !value.target ||
    !value.messageId ||
    !instant(value.fireAt, "reminder fire time")
  )
    throw new Error("invalid reminder job");
  return value;
}
function sync(value: ReminderSync): ReminderSync {
  scope(value);
  value.jobs.forEach(job);
  if (value.jobs.some((item) => item.ownerAgentId !== value.agentId))
    throw new Error("reminder job owner does not match sync Agent");
  if (new Set(value.jobs.map((item) => item.reminderId)).size !== value.jobs.length)
    throw new Error("duplicate reminder job ID");
  if (
    value.messageType !== REMINDER_SYNC_MESSAGE_TYPE ||
    !["snapshot", "upsert", "cancel"].includes(value.operation)
  )
    throw new Error("invalid reminder sync");
  if (value.operation === "upsert" && value.jobs.length !== 1)
    throw new Error("upsert requires one reminder job");
  if (
    value.operation === "cancel" &&
    (value.jobs.length ||
      !value.reminderId ||
      !isReminderId(value.reminderId) ||
      !positive(value.version, "reminder version"))
  )
    throw new Error("cancel requires reminder ID and version");
  if (
    value.operation !== "cancel" &&
    (value.reminderId !== undefined || value.version !== undefined)
  )
    throw new Error("unexpected reminder cancellation fields");
  return value;
}
export function encodeReminderSync(value: ReminderSync) {
  return bounded(toBinary(ReminderSyncSchema, create(ReminderSyncSchema, sync(value))));
}
export function decodeReminderSync(bytes: Uint8Array): ReminderSync {
  const v = fromBinary(ReminderSyncSchema, bounded(bytes));
  return sync({
    ...optional(v),
    operation: v.operation as ReminderSync["operation"],
    jobs: v.jobs.map((j) => optional(j) as ReminderJob),
    messageType: v.messageType as typeof REMINDER_SYNC_MESSAGE_TYPE,
  } as ReminderSync);
}

function fireRequest(value: ReminderFireRequest) {
  scope(value);
  if (
    !isReminderId(value.reminderId) ||
    !positive(value.version, "reminder version") ||
    !instant(value.firedAtClient, "client fire time")
  )
    throw new Error("invalid reminder fire request");
  return value;
}
export function encodeReminderFireRequest(value: ReminderFireRequest) {
  return bounded(
    toBinary(ReminderFireRequestSchema, create(ReminderFireRequestSchema, fireRequest(value))),
  );
}
export function decodeReminderFireRequest(bytes: Uint8Array): ReminderFireRequest {
  return fireRequest(
    optional(fromBinary(ReminderFireRequestSchema, bounded(bytes))) as ReminderFireRequest,
  );
}
function fireResponse(value: ReminderFireResponse) {
  scope(value);
  if (
    !isReminderId(value.reminderId) ||
    !positive(value.version, "reminder version") ||
    !["accepted", "premature", "obsolete"].includes(value.result) ||
    (value.result !== "accepted" && value.fired) ||
    (value.catchup && value.result !== "accepted") ||
    (value.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(value.retryAfterMs) ||
        value.retryAfterMs < 1 ||
        value.retryAfterMs > 0xffffffff)) ||
    (value.result === "premature" && value.retryAfterMs === undefined) ||
    (value.result !== "premature" && value.retryAfterMs !== undefined)
  )
    throw new Error("invalid reminder fire response");
  return value;
}
export function encodeReminderFireResponse(value: ReminderFireResponse) {
  return bounded(
    toBinary(ReminderFireResponseSchema, create(ReminderFireResponseSchema, fireResponse(value))),
  );
}
export function decodeReminderFireResponse(bytes: Uint8Array): ReminderFireResponse {
  const v = fromBinary(ReminderFireResponseSchema, bounded(bytes));
  return fireResponse({
    ...optional(v),
    result: v.result as ReminderFireResponse["result"],
  } as ReminderFireResponse);
}
export function encodeReminderSnapshotRequest(value: ReminderSnapshotRequest) {
  return bounded(
    toBinary(ReminderSnapshotRequestSchema, create(ReminderSnapshotRequestSchema, scope(value))),
  );
}
export function decodeReminderSnapshotRequest(bytes: Uint8Array): ReminderSnapshotRequest {
  return scope(
    optional(fromBinary(ReminderSnapshotRequestSchema, bounded(bytes))) as ReminderSnapshotRequest,
  );
}

function local(value: LocalReminderRequest): LocalReminderRequest {
  if (
    !ID.test(value.requestId) ||
    !value.context ||
    ![...OPERATIONS, "ack", "dismiss"].includes(value.operation)
  )
    throw new Error("invalid local reminder request");
  fields(value);
  if (["ack", "dismiss"].includes(value.operation)) {
    const businessFields = [
      "title",
      "messageId",
      "target",
      "fireAt",
      "delaySeconds",
      "repeat",
      "timezone",
      "status",
      "all",
    ] as const;
    if (
      !value.reminderId ||
      !positive(value.revision, "reminder revision") ||
      businessFields.some((name) => value[name] !== undefined)
    )
      throw new Error("invalid local reminder receipt");
  } else {
    operation({
      ...value,
      protocolMajor: 1,
      workspaceId: "local",
      computerId: "local",
      agentId: "local",
      operation: value.operation as ReminderOperation,
    });
  }
  return value;
}
export function encodeLocalReminderRequest(value: LocalReminderRequest) {
  return bounded(
    toBinary(LocalReminderRequestSchema, create(LocalReminderRequestSchema, local(value))),
  );
}
export function decodeLocalReminderRequest(bytes: Uint8Array): LocalReminderRequest {
  const v = fromBinary(LocalReminderRequestSchema, bounded(bytes));
  return local(optional(v) as LocalReminderRequest);
}
