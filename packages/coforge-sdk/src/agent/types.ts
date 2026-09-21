import type { TaskCommand, TaskResult } from "../internal/tasks";

/** `Omit` over a union collapses it to the keys every member shares; this keeps each member's own
 * fields. Needed wherever a union-shaped command also has to be described for the wire. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * JSON contract used by the versioned Agent HTTPS task endpoint. Its own shape, deliberately not
 * `TaskCommand`: that command is shared with the protobuf codec on the WebSocket path, which names
 * the request's key `requestId`, while our HTTP API names it `idempotencyKey` (Raft's own name).
 * The two meet in the route, not in a type both paths borrow.
 */
export type AgentTaskRequest = DistributiveOmit<TaskCommand, "requestId"> & {
  idempotencyKey: string;
};
export type AgentTaskResponse = TaskResult & {
  idempotencyKey: string;
};

export type AgentReminderRequest = import("../internal/reminder").AgentReminderOperationRequest;
export type AgentReminderResponse = import("../internal/reminder").AgentReminderOperationResponse;
