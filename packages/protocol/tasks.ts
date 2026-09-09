/** Message-backed Task contract shared by browser, Agent RPC and backend. */
export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskView = {
  messageId: string;
  conversationId: string;
  number: number;
  title: string;
  status: TaskStatus;
  revision: number;
  owner: { memberId: string; kind: "user" | "agent"; name: string } | null;
};

export type TaskCommand = {
  operation: "list" | "create" | "convert" | "claim" | "unclaim" | "update";
  requestId: string;
  /** Browser callers identify the conversation; Agent callers use its public target. */
  conversationId?: string;
  target?: string;
  number?: number;
  messageId?: string;
  title?: string;
  attachmentId?: string;
  status?: TaskStatus;
  expectedRevision?: number;
};

export type TaskResult = { tasks: TaskView[] };

export type TaskPrincipal = {
  workspaceId: string;
  userId?: string;
  agentId?: string;
};
