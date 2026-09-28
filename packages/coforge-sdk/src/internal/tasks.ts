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
  /** Set when the member has left the conversation; the Task still names them. */
  left?: boolean;
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
  creator: TaskMember;
  createdAt: string;
  updatedAt: string;
  /** The conversation's target (`#channel` or `@user`); an Agent's own cross-conversation list sets it. */
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

/** One claim selector's outcome. A refused claim is a result, not an error: `reason` says why,
 * and `conflict` is set when another member holds the Task. */
export type TaskClaimResult = {
  number?: number;
  messageId?: string;
  success: boolean;
  reason?: string;
  conflict?: TaskClaimConflict;
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

/** The conversation kinds an Agent's own Task list reads: channels and direct messages. */
export type TaskConversationKind = "channel" | "dm";

/**
 * What an Agent's own Task list covered. The server derives it from the query it ran, so the
 * Agent can tell an empty list from a scope the list never looked at.
 */
export type TaskListCoverage = {
  /** Always `incomplete`: conversations outside the covered scope are not checked. */
  status: "incomplete";
  visibleConversationKinds: TaskConversationKind[];
  includesArchived: boolean;
  /** The list makes no claim about Tasks in conversations it did not read. */
  inaccessibleScope: "not_asserted";
  reason: string;
};

/** An Agent's own Task list is never cut short: every covered match is returned. */
export type TaskListPagination = { mode: "complete"; truncated: false };

export type TaskResult = {
  tasks: TaskView[];
  /** Set only on an Agent's own (`mine`) list. */
  coverage?: TaskListCoverage;
  /** Set only on an Agent's own (`mine`) list. */
  pagination?: TaskListPagination;
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
};

/** What another member's hold on a Task stops: the only action a refused claim blocks. */
export const TASK_CLAIM_BLOCKED_ACTIONS = ["start_conflicting_execution"] as const;

/**
 * Another member holds the Task a claim named. The holder is read in the same transaction that
 * refused the claim, and `observedAt` is when: a snapshot, not a ruling that stays true.
 */
export type TaskClaimConflict = {
  kind: "claim_conflict";
  conflictScope: "implementation_execution";
  /** Every action this conflict blocks; an action not listed is not blocked by it. */
  blockedActions: (typeof TASK_CLAIM_BLOCKED_ACTIONS)[number][];
  /** Illustrative, not exhaustive, and never a permission table. */
  unblockedActionExamples: string[];
  /** The holder by handle; `deleted` marks a deleted Agent that still holds the Task. */
  currentAssignee: { type: "user" | "agent"; name: string; deleted?: boolean };
  taskStatus: TaskStatus;
  /** When the holder claimed it; null when a person assigned it and it was not claimed since. */
  claimedAt: string | null;
  observedAt: string;
};

export type TaskPrincipal = {
  workspaceId: string;
  userId?: string;
  agentId?: string;
};
