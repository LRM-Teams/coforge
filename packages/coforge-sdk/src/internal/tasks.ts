/** Message-backed Task contract shared by browser, Agent RPC and backend. */
import type { AgentMessageRecord } from "./local-daemon";

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskView = {
  messageId: string;
  conversationId: string;
  number: number;
  title: string;
  description?: string | null;
  status: TaskStatus;
  revision: number;
  owner: { memberId: string; kind: "user" | "agent"; name: string } | null;
  channelRef?: string;
  requiresResourceReceipt?: boolean;
  resourceReceiptRecordedAt?: string | null;
  resourceReceipt?: TaskResourceReceipt;
  claimedAt?: string | null;
};

export type TaskResourceReceipt = {
  object: string;
  purpose: string;
  teardownOwner: string;
  securityPrivacy: string;
  expiry: string;
  runbook: string;
  tracking: string;
};

export type TaskClaimResult = {
  number?: number;
  messageId?: string;
  success: boolean;
  reason?: string;
};

export type TaskHistoryEvent = {
  id: string;
  sequence: number;
  eventType: string;
  actorKind: "user" | "agent" | "system";
  actorName: string | null;
  beforeTitle?: string;
  afterTitle?: string;
  beforeDescription?: string | null;
  afterDescription?: string | null;
  createdAt: string;
};

export type TaskCommand = {
  operation:
    | "list"
    | "create"
    | "convert"
    | "claim"
    | "unclaim"
    | "update"
    | "assign"
    | "unassign"
    | "amend"
    | "history"
    | "delete"
    | "receipt";
  requestId: string;
  /** Browser callers identify the conversation; Agent callers use its public target. */
  conversationId?: string;
  target?: string;
  number?: number;
  numbers?: number[];
  messageId?: string;
  messageIds?: string[];
  title?: string;
  titles?: string[];
  description?: string | null;
  assignee?: string | null;
  mine?: boolean;
  createsResource?: boolean;
  receipt?: TaskResourceReceipt;
  freshnessContextMode?: "inline" | "withheld";
  attachmentId?: string;
  status?: TaskStatus | "all";
  expectedRevision?: number;
};

export type TaskResult = {
  tasks: TaskView[];
  claims?: TaskClaimResult[];
  history?: TaskHistoryEvent[];
  assignmentReceipt?: {
    messageId: string;
    content: string;
    assignee: string;
    state: "started" | "assigned";
  };
  resourceFollowup?: {
    id: string;
    ownerAgentId: string;
    owner: string;
    fireAt: string;
    messageId: string;
    conversationId: string;
  };
  state?: "held";
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  heldMessages?: AgentMessageRecord[];
  newMessageCount?: number;
  claimConflict?: TaskClaimConflict;
};

export type TaskClaimConflict = {
  kind: "claim_conflict";
  conflictScope: "implementation_execution";
  blockedActions: string[];
  unblockedActionExamples: string[];
  currentAssignee: { type: "user" | "agent"; name: string | null } | null;
  taskStatus: TaskStatus;
  claimedAt: string;
  observedAt: string;
};

export type TaskPrincipal = {
  workspaceId: string;
  userId?: string;
  agentId?: string;
};
