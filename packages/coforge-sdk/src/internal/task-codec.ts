import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentMessageRecordSchema } from "./gen/coforge/rpc/v1/local_rpc_pb";
import {
  TaskAssignmentReceiptSchema,
  TaskClaimConflictSchema,
  TaskClaimResultSchema,
  TaskCurrentAssigneeSchema,
  TaskHistoryEventSchema,
  TaskOwnerSchema,
  TaskRequestSchema,
  TaskResourceFollowupSchema,
  TaskResourceReceiptSchema,
  TaskResponseSchema,
  TaskViewSchema,
} from "./gen/coforge/rpc/v1/task_pb";
import { decodeLocalAttachment, decodeMessageTask, encodeLocalAttachment } from "./local-daemon";
import {
  TASK_STATUSES,
  type TaskClaimConflict,
  type TaskCommand,
  type TaskResourceReceipt,
  type TaskResult,
  type TaskView,
} from "./tasks";

export const AGENT_TASK_METHOD = "agent:task" as const;
export const TASK_PROTOCOL_MAJOR = 1 as const;
export type TaskRequest = TaskCommand & {
  protocolMajor: number;
  workspaceId: string;
  agentId: string;
};
export type TaskResponse = TaskResult & { protocolMajor: number; requestId: string };

const operations = new Set<TaskCommand["operation"]>([
  "list",
  "create",
  "convert",
  "claim",
  "unclaim",
  "update",
  "assign",
  "amend",
  "history",
  "delete",
  "receipt",
]);
const statuses = new Set<string>(TASK_STATUSES);
const modes = new Set(["inline", "withheld"]);
const actorKinds = new Set(["user", "agent", "system"]);
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

function decodeReceipt(value: TaskResourceReceipt): TaskResourceReceipt {
  return {
    object: value.object,
    purpose: value.purpose,
    teardownOwner: value.teardownOwner,
    securityPrivacy: value.securityPrivacy,
    expiry: value.expiry,
    runbook: value.runbook,
    tracking: value.tracking,
  };
}

export function validateTaskRequest(value: TaskRequest): void {
  if (!value || typeof value !== "object" || value.protocolMajor !== TASK_PROTOCOL_MAJOR)
    throw new Error("unsupported Task protocol major");
  if (
    !isNonblank(value.requestId) ||
    !isNonblank(value.workspaceId) ||
    !isNonblank(value.agentId) ||
    !operations.has(value.operation)
  )
    throw new Error("invalid Task request");
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

export function encodeTaskRequest(value: TaskRequest): Uint8Array {
  validateTaskRequest(value);
  return toBinary(
    TaskRequestSchema,
    create(TaskRequestSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      agentId: value.agentId,
      operation: value.operation,
      target: value.target,
      number: value.number,
      numbers: value.numbers,
      messageId: value.messageId,
      messageIds: value.messageIds,
      title: value.title,
      titles: value.titles,
      status: value.status,
      expectedRevision: value.expectedRevision,
      mine: value.mine,
      createsResource: value.createsResource,
      freshnessContextMode: value.freshnessContextMode,
      assignee: value.assignee ?? undefined,
      description: value.description ?? undefined,
      clearAssignee: value.assignee === null,
      clearDescription: value.description === null,
      receipt: value.receipt ? create(TaskResourceReceiptSchema, value.receipt) : undefined,
    }),
  );
}

export function decodeTaskRequest(bytes: Uint8Array): TaskRequest {
  const value = fromBinary(TaskRequestSchema, bytes);
  const request: TaskRequest = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    operation: value.operation as TaskCommand["operation"],
    ...(value.target !== undefined && { target: value.target }),
    ...(value.number !== undefined && { number: value.number }),
    ...(value.messageId !== undefined && { messageId: value.messageId }),
    ...(value.title !== undefined && { title: value.title }),
    ...(value.status !== undefined && { status: value.status as TaskCommand["status"] }),
    ...(value.expectedRevision !== undefined && { expectedRevision: value.expectedRevision }),
    ...(value.titles.length && { titles: value.titles }),
    ...(value.numbers.length && { numbers: value.numbers }),
    ...(value.messageIds.length && { messageIds: value.messageIds }),
    ...(value.mine !== undefined && { mine: value.mine }),
    ...(value.clearAssignee
      ? { assignee: null }
      : value.assignee !== undefined && { assignee: value.assignee }),
    ...(value.clearDescription
      ? { description: null }
      : value.description !== undefined && { description: value.description }),
    ...(value.createsResource !== undefined && { createsResource: value.createsResource }),
    ...(value.receipt && { receipt: decodeReceipt(value.receipt) }),
    ...(value.freshnessContextMode !== undefined && {
      freshnessContextMode: value.freshnessContextMode as TaskCommand["freshnessContextMode"],
    }),
  };
  validateTaskRequest(request);
  return request;
}

const encodeView = (task: TaskView) => {
  if (
    task.requiresResourceReceipt !== undefined &&
    typeof task.requiresResourceReceipt !== "boolean"
  )
    throw new Error("invalid Task response");
  return create(TaskViewSchema, {
    ...task,
    description: task.description ?? undefined,
    descriptionIsNull: task.description === null,
    owner: task.owner ? create(TaskOwnerSchema, task.owner) : undefined,
    resourceReceipt: task.resourceReceipt
      ? create(TaskResourceReceiptSchema, task.resourceReceipt)
      : undefined,
    resourceReceiptRecordedAt: task.resourceReceiptRecordedAt ?? undefined,
    resourceReceiptRecordedAtIsNull: task.resourceReceiptRecordedAt === null,
    claimedAt: task.claimedAt ?? undefined,
    claimedAtIsNull: task.claimedAt === null,
  });
};

function decodeView(
  task: ReturnType<typeof fromBinary<typeof TaskResponseSchema>>["tasks"][number],
): TaskView {
  if (
    !isNonblank(task.messageId) ||
    !isNonblank(task.conversationId) ||
    !isPgPositive(task.number) ||
    !isNonblank(task.title) ||
    task.title.length > 10_000 ||
    !statuses.has(task.status) ||
    !isPgNonnegative(task.revision) ||
    (task.description !== undefined && task.description.length > 50_000) ||
    (task.owner &&
      (!isNonblank(task.owner.memberId) ||
        !["user", "agent"].includes(task.owner.kind) ||
        !isNonblank(task.owner.name))) ||
    (task.resourceReceipt && !validReceipt(task.resourceReceipt)) ||
    (task.resourceReceiptRecordedAt !== undefined && !isIsoDate(task.resourceReceiptRecordedAt)) ||
    (task.claimedAt !== undefined && !isIsoDate(task.claimedAt))
  )
    throw new Error("invalid Task response");
  return {
    messageId: task.messageId,
    conversationId: task.conversationId,
    number: task.number,
    title: task.title,
    ...(task.descriptionIsNull
      ? { description: null }
      : task.description !== undefined && { description: task.description }),
    status: task.status as TaskView["status"],
    revision: task.revision,
    owner: task.owner
      ? {
          memberId: task.owner.memberId,
          kind: task.owner.kind as "user" | "agent",
          name: task.owner.name,
        }
      : null,
    ...(task.channelRef !== undefined && { channelRef: task.channelRef }),
    ...(task.requiresResourceReceipt !== undefined && {
      requiresResourceReceipt: task.requiresResourceReceipt,
    }),
    ...(task.resourceReceiptRecordedAtIsNull
      ? { resourceReceiptRecordedAt: null }
      : task.resourceReceiptRecordedAt !== undefined && {
          resourceReceiptRecordedAt: task.resourceReceiptRecordedAt,
        }),
    ...(task.resourceReceipt && { resourceReceipt: decodeReceipt(task.resourceReceipt) }),
    ...(task.claimedAtIsNull
      ? { claimedAt: null }
      : task.claimedAt !== undefined && { claimedAt: task.claimedAt }),
  };
}

function encodeConflict(conflict: TaskClaimConflict) {
  return create(TaskClaimConflictSchema, {
    ...conflict,
    currentAssignee: conflict.currentAssignee
      ? create(TaskCurrentAssigneeSchema, {
          ...conflict.currentAssignee,
          name: conflict.currentAssignee.name ?? undefined,
          nameIsNull: conflict.currentAssignee.name === null,
        })
      : undefined,
    currentAssigneeIsNull: conflict.currentAssignee === null,
  });
}
function decodeConflict(
  value: NonNullable<ReturnType<typeof fromBinary<typeof TaskResponseSchema>>["claimConflict"]>,
): TaskClaimConflict {
  if (
    value.kind !== "claim_conflict" ||
    value.conflictScope !== "implementation_execution" ||
    !Array.isArray(value.blockedActions) ||
    !value.blockedActions.every(isNonblank) ||
    !value.unblockedActionExamples.every(isNonblank) ||
    !statuses.has(value.taskStatus) ||
    !isIsoDate(value.claimedAt) ||
    !isIsoDate(value.observedAt) ||
    (value.currentAssignee &&
      (!["user", "agent"].includes(value.currentAssignee.type) ||
        (value.currentAssignee.name !== undefined && !isNonblank(value.currentAssignee.name))))
  )
    throw new Error("invalid Task response");
  return {
    kind: "claim_conflict",
    conflictScope: "implementation_execution",
    blockedActions: value.blockedActions,
    unblockedActionExamples: value.unblockedActionExamples,
    currentAssignee: value.currentAssigneeIsNull
      ? null
      : value.currentAssignee
        ? {
            type: value.currentAssignee.type as "user" | "agent",
            name: value.currentAssignee.nameIsNull ? null : (value.currentAssignee.name ?? null),
          }
        : null,
    taskStatus: value.taskStatus as TaskView["status"],
    claimedAt: value.claimedAt,
    observedAt: value.observedAt,
  };
}

const projectHeld = (value: TaskResponse): TaskResponse =>
  value.freshnessContextMode === "withheld"
    ? {
        protocolMajor: value.protocolMajor,
        requestId: value.requestId,
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount:
          value.withheldMessageCount ?? value.newMessageCount ?? value.heldMessages?.length ?? 0,
      }
    : value;

export function encodeTaskResponse(input: TaskResponse): Uint8Array {
  const value = projectHeld(input);
  if (value.claims?.some((claim) => typeof claim.success !== "boolean"))
    throw new Error("invalid Task response");
  const bytes = toBinary(
    TaskResponseSchema,
    create(TaskResponseSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      tasks: value.tasks.map(encodeView),
      claims: (value.claims ?? []).map((claim) => create(TaskClaimResultSchema, claim)),
      history: (value.history ?? []).map((event) =>
        create(TaskHistoryEventSchema, {
          ...event,
          actorName: event.actorName ?? undefined,
          beforeDescription: event.beforeDescription ?? undefined,
          afterDescription: event.afterDescription ?? undefined,
        }),
      ),
      assignmentReceipt: value.assignmentReceipt
        ? create(TaskAssignmentReceiptSchema, value.assignmentReceipt)
        : undefined,
      resourceFollowup: value.resourceFollowup
        ? create(TaskResourceFollowupSchema, value.resourceFollowup)
        : undefined,
      state: value.state,
      freshnessContextMode: value.freshnessContextMode,
      withheldMessageCount: value.withheldMessageCount,
      newMessageCount: value.newMessageCount,
      heldMessages: (value.heldMessages ?? []).map((message) =>
        create(AgentMessageRecordSchema, {
          ...message,
          sequence: BigInt(message.sequence),
          attachment: message.attachment ? encodeLocalAttachment(message.attachment) : undefined,
          task: message.task,
        }),
      ),
      claimConflict: value.claimConflict ? encodeConflict(value.claimConflict) : undefined,
    }),
  );
  decodeTaskResponse(bytes);
  return bytes;
}

export function decodeTaskResponse(bytes: Uint8Array): TaskResponse {
  const value = fromBinary(TaskResponseSchema, bytes);
  if (
    value.protocolMajor !== TASK_PROTOCOL_MAJOR ||
    !isNonblank(value.requestId) ||
    (value.state !== undefined && value.state !== "held") ||
    (value.freshnessContextMode !== undefined && !modes.has(value.freshnessContextMode)) ||
    (value.withheldMessageCount !== undefined && !isPgNonnegative(value.withheldMessageCount)) ||
    (value.newMessageCount !== undefined && !isPgNonnegative(value.newMessageCount))
  )
    throw new Error("invalid Task response");
  if (value.freshnessContextMode === "withheld")
    return {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      tasks: [],
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount:
        value.withheldMessageCount ?? value.newMessageCount ?? value.heldMessages.length,
    };
  const claims = value.claims.map((claim) => {
    if (
      (claim.number !== undefined && !isPgPositive(claim.number)) ||
      (claim.messageId !== undefined && !isNonblank(claim.messageId)) ||
      (claim.number === undefined && claim.messageId === undefined) ||
      (claim.reason !== undefined && !isNonblank(claim.reason))
    )
      throw new Error("invalid Task response");
    return {
      ...(claim.number !== undefined && { number: claim.number }),
      ...(claim.messageId !== undefined && { messageId: claim.messageId }),
      success: claim.success,
      ...(claim.reason !== undefined && { reason: claim.reason }),
    };
  });
  const history = value.history.map((event) => {
    if (
      !isNonblank(event.id) ||
      !isPgPositive(event.sequence) ||
      !isNonblank(event.eventType) ||
      !actorKinds.has(event.actorKind) ||
      !isIsoDate(event.createdAt)
    )
      throw new Error("invalid Task response");
    return {
      id: event.id,
      sequence: event.sequence,
      eventType: event.eventType,
      actorKind: event.actorKind as "user" | "agent" | "system",
      actorName: event.actorName ?? null,
      beforeTitle: event.beforeTitle,
      afterTitle: event.afterTitle,
      beforeDescription: event.beforeDescription,
      afterDescription: event.afterDescription,
      createdAt: event.createdAt,
    };
  });
  if (
    value.assignmentReceipt &&
    (!isNonblank(value.assignmentReceipt.messageId) ||
      !isNonblank(value.assignmentReceipt.content) ||
      !isNonblank(value.assignmentReceipt.assignee) ||
      !["started", "assigned"].includes(value.assignmentReceipt.state))
  )
    throw new Error("invalid Task response");
  if (
    value.resourceFollowup &&
    (![
      value.resourceFollowup.id,
      value.resourceFollowup.ownerAgentId,
      value.resourceFollowup.owner,
      value.resourceFollowup.messageId,
      value.resourceFollowup.conversationId,
    ].every(isNonblank) ||
      !isIsoDate(value.resourceFollowup.fireAt))
  )
    throw new Error("invalid Task response");
  const heldMessages = value.heldMessages.map((message) => {
    const sequence = Number(message.sequence);
    if (
      !isNonblank(message.id) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !isNonblank(message.sender) ||
      !isNonblank(message.target) ||
      typeof message.body !== "string" ||
      !isIsoDate(message.createdAt)
    )
      throw new Error("invalid Task response");
    return {
      id: message.id,
      sequence,
      sender: message.sender,
      target: message.target,
      body: message.body,
      createdAt: message.createdAt,
      ...decodeLocalAttachment(message.attachment),
      ...(message.task ? { task: decodeMessageTask(message.task) } : {}),
    };
  });
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    tasks: value.tasks.map(decodeView),
    ...(claims.length && { claims }),
    ...(history.length && { history }),
    ...(value.assignmentReceipt && {
      assignmentReceipt: {
        messageId: value.assignmentReceipt.messageId,
        content: value.assignmentReceipt.content,
        assignee: value.assignmentReceipt.assignee,
        state: value.assignmentReceipt.state as "started" | "assigned",
      },
    }),
    ...(value.resourceFollowup && { resourceFollowup: { ...value.resourceFollowup } }),
    ...(value.state !== undefined && { state: value.state as "held" }),
    ...(value.freshnessContextMode !== undefined && {
      freshnessContextMode: value.freshnessContextMode as "inline",
    }),
    ...(value.withheldMessageCount !== undefined && {
      withheldMessageCount: value.withheldMessageCount,
    }),
    ...(heldMessages.length && { heldMessages }),
    ...(value.newMessageCount !== undefined && { newMessageCount: value.newMessageCount }),
    ...(value.claimConflict && { claimConflict: decodeConflict(value.claimConflict) }),
  };
}
