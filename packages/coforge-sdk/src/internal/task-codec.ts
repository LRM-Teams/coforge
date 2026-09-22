import {
  TASK_STATUSES,
  type TaskCommand,
  type TaskResourceReceipt,
  type TaskResult,
} from "./tasks";

/**
 * The request the daemon puts on the Agent HTTPS task route: the board's command, nothing else.
 * The former request envelope (`protocolMajor`, `workspaceId`, `agentId`) is gone — the route
 * derives its principal from the Agent API key and never trusted these body fields. The
 * idempotency key is named `idempotencyKey` here and everywhere the JSON path sees it — there is
 * no other name on the wire. (Protobuf payloads keep their own `request_id` spelling; that is the
 * WebSocket path's contract, not HTTP's.)
 */
export type TaskRequest = TaskCommand;

/** The route echoes the idempotency key alongside the board's result so the caller can correlate. */
export type TaskResponse = TaskResult & { idempotencyKey: string };

const operations = new Set<TaskCommand["operation"]>([
  "list",
  "create",
  "convert",
  "claim",
  "unclaim",
  "update",
  "assign",
  "unassign",
  "amend",
  "history",
  "delete",
  "receipt",
]);
const statuses = new Set<string>(TASK_STATUSES);
const modes = new Set(["inline", "withheld"]);
const PG_MAX = 2_147_483_647;
const targetPattern = /^(?:#[a-z0-9][a-z0-9_-]{0,31}|@[a-z0-9][a-z0-9_-]{0,31})$/;
const ownerPattern = /^@[a-z0-9][a-z0-9_-]{0,63}$/;
const isNonblank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isPgPositive = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= PG_MAX;
const isPgNonnegative = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= PG_MAX;
const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value));

function validReceipt(value: unknown): value is TaskResourceReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  const keys = [
    "object",
    "purpose",
    "teardownOwner",
    "securityPrivacy",
    "expiry",
    "runbook",
    "tracking",
  ];
  return (
    keys.every((key) => isNonblank(receipt[key])) &&
    ownerPattern.test(String(receipt.teardownOwner)) &&
    isIsoDate(receipt.expiry)
  );
}

export function validateTaskRequest(value: TaskRequest): void {
  if (!value || typeof value !== "object" || !isNonblank(value.idempotencyKey))
    throw new Error("invalid Task request");
  if (!operations.has(value.operation)) throw new Error("invalid Task request");
  if (
    value.conversationId !== undefined ||
    (value.target ? 1 : 0) + (value.mine === true ? 1 : 0) !== 1 ||
    (value.target !== undefined &&
      (typeof value.target !== "string" || !targetPattern.test(value.target)))
  )
    throw new Error("invalid Task target");
  if (value.mine !== undefined && typeof value.mine !== "boolean")
    throw new Error("invalid Task request");
  if (value.mine && value.operation !== "list") throw new Error("invalid Task target");
  if (value.number !== undefined && !isPgPositive(value.number))
    throw new Error("invalid Task number");
  if (
    value.numbers !== undefined &&
    (!Array.isArray(value.numbers) ||
      value.numbers.length === 0 ||
      !value.numbers.every(isPgPositive))
  )
    throw new Error("invalid Task number");
  if (value.expectedRevision !== undefined && !isPgNonnegative(value.expectedRevision))
    throw new Error("invalid Task revision");
  if (value.messageId !== undefined && !isNonblank(value.messageId))
    throw new Error("invalid Task message");
  if (
    value.messageIds !== undefined &&
    (!Array.isArray(value.messageIds) ||
      value.messageIds.length === 0 ||
      !value.messageIds.every(isNonblank))
  )
    throw new Error("invalid Task message");
  if (value.title !== undefined && (!isNonblank(value.title) || value.title.length > 10_000))
    throw new Error("invalid Task title");
  if (
    value.titles !== undefined &&
    (!Array.isArray(value.titles) ||
      value.titles.length === 0 ||
      !value.titles.every((title) => isNonblank(title) && title.length <= 10_000))
  )
    throw new Error("invalid Task title");
  if (
    value.description !== undefined &&
    value.description !== null &&
    (typeof value.description !== "string" || value.description.length > 50_000)
  )
    throw new Error("invalid Task description");
  if (
    value.status !== undefined &&
    !(statuses.has(value.status) || (value.operation === "list" && value.status === "all"))
  )
    throw new Error("invalid Task status");
  if (value.freshnessContextMode !== undefined && !modes.has(value.freshnessContextMode))
    throw new Error("invalid Task mode");
  if (value.createsResource !== undefined && typeof value.createsResource !== "boolean")
    throw new Error("invalid Task request");
  if (value.receipt !== undefined && !validReceipt(value.receipt))
    throw new Error("invalid Task receipt");
  if (
    value.operation !== "claim" &&
    (value.number !== undefined || value.numbers !== undefined) &&
    (value.messageId !== undefined || value.messageIds !== undefined)
  )
    throw new Error("invalid Task selectors");

  const numeric = value.number !== undefined || value.numbers !== undefined;
  const messages = value.messageId !== undefined || value.messageIds !== undefined;
  const valid =
    (value.operation === "list" &&
      value.title === undefined &&
      value.titles === undefined &&
      !numeric &&
      !messages) ||
    (value.operation === "create" &&
      (value.title !== undefined) !== (value.titles !== undefined) &&
      !numeric &&
      !messages) ||
    (value.operation === "convert" &&
      value.messageId !== undefined &&
      value.messageIds === undefined &&
      !numeric) ||
    (value.operation === "claim" && (numeric || messages)) ||
    (["unclaim", "history", "delete"].includes(value.operation) &&
      value.number !== undefined &&
      value.numbers === undefined &&
      !messages) ||
    (value.operation === "unassign" &&
      value.number !== undefined &&
      value.numbers === undefined &&
      !messages &&
      value.assignee === undefined) ||
    (value.operation === "update" &&
      value.number !== undefined &&
      value.numbers === undefined &&
      !messages &&
      value.status !== undefined &&
      value.status !== "all") ||
    (value.operation === "assign" &&
      value.number !== undefined &&
      value.numbers === undefined &&
      !messages &&
      value.assignee !== undefined) ||
    (value.operation === "amend" &&
      value.number !== undefined &&
      value.numbers === undefined &&
      !messages &&
      (value.title !== undefined || value.description !== undefined)) ||
    (value.operation === "receipt" &&
      value.number !== undefined &&
      value.numbers === undefined &&
      !messages &&
      value.receipt !== undefined);
  if (!valid) throw new Error("missing Task operation argument");
}
