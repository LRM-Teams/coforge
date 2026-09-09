import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { TaskRequestSchema, TaskResponseSchema } from "./gen/coforge/rpc/v1/task_pb";
import { TASK_STATUSES, type TaskCommand, type TaskResult, type TaskView } from "./tasks";

export const AGENT_TASK_METHOD = "agent:task" as const;
export const TASK_PROTOCOL_MAJOR = 1 as const;
export type TaskRequest = TaskCommand & {
  protocolMajor: number;
  workspaceId: string;
  agentId: string;
};
export type TaskResponse = TaskResult & { protocolMajor: number; requestId: string };

const operations = new Set(["list", "create", "convert", "claim", "unclaim", "update"]);
const statuses = new Set<string>(TASK_STATUSES);
const ownerKinds = new Set(["user", "agent"]);
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const targetPattern = /^(?:#[a-z0-9][a-z0-9_-]{0,31}|@[a-z0-9][a-z0-9_-]{0,31})$/;

export function validateTaskRequest(value: TaskRequest): void {
  if (value.protocolMajor !== TASK_PROTOCOL_MAJOR)
    throw new Error("unsupported Task protocol major");
  if (!value.requestId || !value.workspaceId || !value.agentId || !operations.has(value.operation))
    throw new Error("invalid Task request");
  if (!value.target || !targetPattern.test(value.target)) throw new Error("invalid Task target");
  if (
    value.number !== undefined &&
    (!Number.isSafeInteger(value.number) || value.number < 1 || value.number > POSTGRES_INTEGER_MAX)
  )
    throw new Error("invalid Task number");
  if (
    value.expectedRevision !== undefined &&
    (!Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 0 ||
      value.expectedRevision > POSTGRES_INTEGER_MAX)
  )
    throw new Error("invalid Task revision");
  if (value.status !== undefined && !statuses.has(value.status))
    throw new Error("invalid Task status");
  const valid =
    value.operation === "list" ||
    (value.operation === "create" && Boolean(value.title?.trim())) ||
    (value.operation === "convert" && Boolean(value.messageId)) ||
    (value.operation === "claim" && (value.number !== undefined) !== Boolean(value.messageId)) ||
    (value.operation === "unclaim" &&
      value.number !== undefined &&
      value.expectedRevision !== undefined) ||
    (value.operation === "update" &&
      value.number !== undefined &&
      value.status !== undefined &&
      value.expectedRevision !== undefined);
  if (!valid) throw new Error("missing Task operation argument");
}

export function encodeTaskRequest(value: TaskRequest): Uint8Array {
  validateTaskRequest(value);
  return toBinary(TaskRequestSchema, create(TaskRequestSchema, value));
}

export function decodeTaskRequest(bytes: Uint8Array): TaskRequest {
  const value = fromBinary(TaskRequestSchema, bytes);
  const request = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    operation: value.operation as TaskCommand["operation"],
    target: value.target,
    number: value.number,
    messageId: value.messageId,
    title: value.title,
    status: value.status as TaskCommand["status"],
    expectedRevision: value.expectedRevision,
  };
  validateTaskRequest(request);
  return request;
}

const encodeView = (task: TaskView) => ({ ...task, owner: task.owner ?? undefined });
const decodeView = (
  task: ReturnType<typeof fromBinary<typeof TaskResponseSchema>>["tasks"][number],
): TaskView => {
  if (
    !task.messageId ||
    !task.conversationId ||
    !Number.isSafeInteger(task.number) ||
    task.number < 1 ||
    task.number > POSTGRES_INTEGER_MAX ||
    !statuses.has(task.status) ||
    !Number.isSafeInteger(task.revision) ||
    task.revision < 0 ||
    task.revision > POSTGRES_INTEGER_MAX ||
    (task.owner !== undefined && (!task.owner.memberId || !ownerKinds.has(task.owner.kind)))
  )
    throw new Error("invalid Task response");
  return {
    messageId: task.messageId,
    conversationId: task.conversationId,
    number: task.number,
    title: task.title,
    status: task.status as TaskView["status"],
    revision: task.revision,
    owner: task.owner
      ? {
          memberId: task.owner.memberId,
          kind: task.owner.kind as "user" | "agent",
          name: task.owner.name,
        }
      : null,
  };
};

export function encodeTaskResponse(value: TaskResponse): Uint8Array {
  return toBinary(
    TaskResponseSchema,
    create(TaskResponseSchema, { ...value, tasks: value.tasks.map(encodeView) }),
  );
}
export function decodeTaskResponse(bytes: Uint8Array): TaskResponse {
  const value = fromBinary(TaskResponseSchema, bytes);
  if (value.protocolMajor !== TASK_PROTOCOL_MAJOR || !value.requestId)
    throw new Error("invalid Task response");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    tasks: value.tasks.map(decodeView),
  };
}
