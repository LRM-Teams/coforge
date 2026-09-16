import type { TaskCommand, TaskResult } from "../internal/tasks";

/** JSON contract used by the versioned Agent HTTPS task endpoint. */
export type AgentTaskRequest = TaskCommand;
export type AgentTaskResponse = TaskResult & {
  requestId: string;
};

export type AgentReminderRequest = import("../internal/reminder").AgentReminderOperationRequest;
export type AgentReminderResponse = import("../internal/reminder").AgentReminderOperationResponse;
