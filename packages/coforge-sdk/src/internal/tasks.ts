/** Message-backed Task contract shared by browser, Agent RPC and backend. */
import type { AgentMessageRecord } from "./local-daemon";

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A conversation member named on a Task: its owner or its creator. */
export type TaskMember = {
  memberId: string;
  kind: "user" | "agent";
  /** The User or Agent id behind the member, as history payloads name an assignee. */
  id: string;
  name: string;
  /** The username or Agent name. */
  handle: string;
  /** True when the named Agent has been deleted: the identity still reads, with its DELETED marker. */
  deleted?: boolean;
  /** Where the browser reads a human's avatar; absent for an Agent. */
  avatarUrl?: string | null;
};

export type TaskView = {
  messageId: string;
  conversationId: string;
  number: number;
  title: string;
  description?: string | null;
  status: TaskStatus;
  revision: number;
  owner: TaskMember | null;
  /** Who created the Task; only the history read carries it. */
  creator?: TaskMember;
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

/** One Task change as history records it: `payload` carries the facts its `eventType` names. */
export type TaskHistoryChange =
  | { eventType: "created"; payload: { taskNumber: number; status: TaskStatus } }
  | { eventType: "status_changed"; payload: { from: TaskStatus; to: TaskStatus } }
  | {
      eventType: "assignee_changed";
      /** A User or Agent id, both null when the Task was unassigned. */
      payload: { assigneeId: string | null; assigneeType: "user" | "agent" | null };
    }
  | {
      eventType: "amended";
      payload: {
        changes: {
          title?: { from: string; to: string };
          description?: { from: string | null; to: string | null };
        };
        /** The Task revision this amendment produced; absent on amendments recorded before it. */
        revision?: number;
      };
    };

export type TaskHistoryEvent = {
  id: string;
  seq: number;
  actorType: "user" | "agent" | "system";
  /** The actor's handle when the event was recorded. */
  actorName: string | null;
  createdAt: string;
} & TaskHistoryChange;

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
  idempotencyKey: string;
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
