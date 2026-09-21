import type { TaskCommand, TaskResult } from "../internal/tasks";

/** `Omit` over a union collapses it to the keys every member shares; this keeps each member's own
 * fields. Needed wherever a union-shaped command also has to be described for the wire. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * JSON contract used by the versioned Agent HTTPS task endpoint: the board's command, whose
 * idempotency key is named `idempotencyKey` — the one name the HTTP path uses for it, on both
 * sides. (Protobuf payloads keep their own `request_id` spelling; that is the WebSocket path's
 * contract, not HTTP's.)
 */
export type AgentTaskRequest = TaskCommand;
export type AgentTaskResponse = TaskResult & {
  idempotencyKey: string;
};

export type AgentReminderRequest = import("../internal/reminder").AgentReminderOperationRequest;
export type AgentReminderResponse = import("../internal/reminder").AgentReminderOperationResponse;
