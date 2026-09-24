import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import {
  REMINDER_SYNC_MESSAGE_TYPE,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeReminderSync,
  type TaskCommand,
  type TaskHistoryChange,
  type TaskHistoryEvent,
  type TaskMember,
  type TaskPrincipal,
  type TaskResult,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { encodeAgentDelivery } from "#src/server/conversations/agent-delivery.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { channelThreadRootWhere } from "#src/server/db/message-anchor.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  conversationSignalScopes,
  messageSignalScope,
  type ConversationRealtime,
  type MessageSignalScope,
} from "#src/server/conversations/conversation-realtime.server";
import {
  agentReadableBody,
  MESSAGE_MENTIONS_SELECT,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import { storeMessageBody } from "#src/server/conversations/message-references.server";
import {
  ACTIVE_MEMBER_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import {
  agentMessageSender,
  browserSenderHandle,
  MESSAGE_SENDER_SELECT,
  type AgentMessageSender,
} from "#src/server/conversations/sender-display.server";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { MAX_ACTIVE_REMINDERS } from "#src/server/reminders/reminders.server";
import {
  assigneeMention,
  noticeActor,
  noticeText,
  quotedTask,
  type QuotedTask,
} from "./task-notices.server";
import { FINISHED_TASKS_PAGE } from "#src/features/tasks/task-overview-limits";

type Dependencies = {
  realtime?: ConversationRealtime;
  notifications?: MessageNotifier;
  publisher?: Pick<CentrifugoServerApi, "publish">;
};

const TASK_MEMBER_SELECT = {
  id: true,
  userId: true,
  agentId: true,
  user: { select: { username: true, displayName: true, avatarObjectKey: true } },
  agent: { select: { name: true, displayName: true, deletedAt: true } },
} satisfies Prisma.ConversationMemberSelect;

const taskSelection = {
  messageId: true,
  conversationId: true,
  workspaceId: true,
  number: true,
  title: true,
  description: true,
  createsResource: true,
  resourceReceipt: true,
  resourceReceiptRecordedAt: true,
  status: true,
  revision: true,
  claimedAt: true,
  ownerMemberId: true,
  owner: { select: TASK_MEMBER_SELECT },
  // The backing message's sequence, so realtime signals need no second read, and its mention rows,
  // which a title converted from that message needs to read its mention tokens back.
  message: {
    select: { sequence: true, mentions: MESSAGE_MENTIONS_SELECT },
  },
} satisfies Prisma.TaskSelect;

type SelectedTask = Prisma.TaskGetPayload<{ select: typeof taskSelection }>;
type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
/** The acting conversation member; its user/Agent handle names it in Task history and notices. */
type Member = {
  id: string;
  userId: string | null;
  agentId: string | null;
  user?: { username: string; displayName?: string | null } | null;
  agent?: { name: string; displayName?: string | null } | null;
};
const MEMBER_SELECT = {
  id: true,
  userId: true,
  agentId: true,
  user: { select: { username: true, displayName: true } },
  agent: { select: { name: true, displayName: true } },
} satisfies Prisma.ConversationMemberSelect;
/** One conversation of one Workspace: where a Task lives and where its notices go. */
type ConversationRef = { conversationId: string; workspaceId: string };
/** A server notice as written; open pages learn of it once its transaction commits. */
type PostedNotice = ConversationRef & {
  id: string;
  sequence: number;
  threadRootId: string | null;
  body: string;
};
type NoticeInput = {
  id?: string;
  threadRootId?: string;
  body: string;
  deliverTo?: string | null;
  /** The member the notice personally mentions: its one mention row. */
  mentions?: Member;
};
/** The Task fields a notice quotes; `messageId` is also the root of the Task's thread. */
type NoticeSubject = { messageId: string; number: number; title: string };
/**
 * Writes the notices of one Task change, inside the transaction `withNotices` opened under the
 * conversation lock. Ordinary notices are signalled to open pages after the commit; a receipt is
 * the caller's to publish (`publishAssignmentReceipt`), because it is delivered and pushed.
 */
type NoticeWriter = {
  /** The Tasks as notices quote them: clean titles, in the given order. */
  quote(tasks: readonly NoticeSubject[]): Promise<QuotedTask[]>;
  /** A top-level notice in the conversation. */
  inConversation(body: string): Promise<PostedNotice>;
  /** A reply in the Task's own thread. */
  inThread(task: NoticeSubject, body: (task: QuotedTask) => string): Promise<PostedNotice>;
  /**
   * The assignee's receipt: its fixed id, its one mention row naming the assignee (so it reaches a
   * human assignee who muted the channel, and an Agent assignee reads it as its mention), and its
   * one delivery to an Agent assignee. The body stays the server-built `@handle` text.
   */
  receipt(input: { id: string; body: string; assignee: Member }): Promise<PostedNotice>;
};

type HistoryEvent = Prisma.TaskHistoryEventGetPayload<{ select: undefined }>;

export type TaskOverview = {
  tasks: Array<
    TaskView & {
      currentMemberId: string | null;
      source: {
        channelName: string | null;
        agentId: string | null;
        label: string;
      };
      /** The Project the task's channel belongs to; a DM task has none. */
      project: { id: string; name: string; slug: string } | null;
    }
  >;
  /** Whether older Done or Closed Tasks exist than the latest ones listed. */
  more: { done: boolean; closed: boolean };
};

/** A task status as stored; a value outside the known set is corrupt data, not user input. */
export function storedTaskStatus(value: string): TaskStatus {
  switch (value) {
    case "todo":
    case "in_progress":
    case "in_review":
    case "done":
    case "closed":
      return value;
    default:
      throw new AppError("INTERNAL_ERROR");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Task's owner or creator; a conversation member is exactly one of a User or an Agent. */
function taskMember(
  workspaceId: string,
  member: Prisma.ConversationMemberGetPayload<{ select: typeof TASK_MEMBER_SELECT }>,
): TaskMember {
  if (member.agent)
    return {
      memberId: member.id,
      kind: "agent",
      id: member.agentId!,
      name: member.agent.displayName || member.agent.name,
      handle: member.agent.name,
      // A deleted Agent keeps the Tasks it holds so history stays readable; the marker says so
      // rather than letting the card read as if the holder were still live.
      deleted: member.agent.deletedAt !== null,
    };
  const user = member.user!;
  return {
    memberId: member.id,
    kind: "user",
    id: member.userId!,
    name: user.displayName || `@${user.username}`,
    handle: user.username,
    avatarUrl: workspaceUserAvatarUrl(workspaceId, member.userId!, user.avatarObjectKey),
  };
}

function view(task: SelectedTask): TaskView {
  const resourceReceipt = task.resourceReceipt;
  return {
    messageId: task.messageId,
    conversationId: task.conversationId,
    number: task.number,
    // A title converted from a message keeps that message's stored tokens; they read back as text
    // (`@handle`, `task #N`, `#name`) here, the view both the task board and an Agent's `task`
    // commands read.
    title: agentReadableBody(task.title, task.message.mentions),
    description: task.description,
    status: storedTaskStatus(task.status),
    revision: task.revision,
    claimedAt: task.claimedAt?.toISOString() ?? null,
    requiresResourceReceipt: task.createsResource,
    resourceReceiptRecordedAt: task.resourceReceiptRecordedAt?.toISOString() ?? null,
    ...(isRecord(resourceReceipt) && {
      resourceReceipt: {
        object: String(resourceReceipt.object ?? ""),
        purpose: String(resourceReceipt.purpose ?? ""),
        teardownOwner: String(resourceReceipt.teardownOwner ?? ""),
        securityPrivacy: String(resourceReceipt.securityPrivacy ?? ""),
        expiry: String(resourceReceipt.expiry ?? ""),
        runbook: String(resourceReceipt.runbook ?? ""),
        tracking: String(resourceReceipt.tracking ?? ""),
      },
    }),
    owner: task.owner && taskMember(task.workspaceId, task.owner),
  };
}

function historyEventView(event: HistoryEvent): TaskHistoryEvent {
  // Rows are written only through historyRows, which types each payload by its event type.
  return {
    id: event.id,
    seq: event.seq,
    actorType: event.actorType,
    actorName: event.actorName,
    createdAt: event.createdAt.toISOString(),
    eventType: event.eventType,
    payload: event.payload,
  } as TaskHistoryEvent;
}

function assigneeChange(task: SelectedTask): TaskHistoryChange {
  return {
    eventType: "assignee_changed",
    payload: {
      assigneeId: task.owner?.agentId ?? task.owner?.userId ?? null,
      assigneeType: task.owner ? (task.owner.agentId ? "agent" : "user") : null,
    },
  };
}

/** A new Task's history: its creation, then its assignee when it was created assigned. */
function creationChanges(task: SelectedTask): TaskHistoryChange[] {
  const changes: TaskHistoryChange[] = [
    {
      eventType: "created",
      payload: { taskNumber: task.number, status: storedTaskStatus(task.status) },
    },
  ];
  if (task.owner) changes.push(assigneeChange(task));
  return changes;
}

/** What one write changed on a Task, in the order history lists it. */
function taskChanges(before: SelectedTask, after: SelectedTask): TaskHistoryChange[] {
  const changes: TaskHistoryChange[] = [];
  if (before.ownerMemberId !== after.ownerMemberId) changes.push(assigneeChange(after));
  if (before.status !== after.status)
    changes.push({
      eventType: "status_changed",
      payload: { from: storedTaskStatus(before.status), to: storedTaskStatus(after.status) },
    });
  const amended: Extract<TaskHistoryChange, { eventType: "amended" }>["payload"]["changes"] = {};
  // Titles are compared and recorded as `view` shows them, so a title's stored tokens are never
  // written into the record, and a title that reads the same is no change.
  const titles = {
    from: agentReadableBody(before.title, before.message.mentions),
    to: agentReadableBody(after.title, after.message.mentions),
  };
  if (titles.from !== titles.to) amended.title = titles;
  if (before.description !== after.description)
    amended.description = { from: before.description, to: after.description };
  if (amended.title || amended.description)
    changes.push({ eventType: "amended", payload: { changes: amended, revision: after.revision } });
  return changes;
}

/** History rows for one Task, numbered after `latestSeq`. */
function historyRows(
  taskMessageId: string,
  actor: Member,
  changes: TaskHistoryChange[],
  latestSeq: number,
): Prisma.TaskHistoryEventCreateManyInput[] {
  return changes.map((change, index) => ({
    taskMessageId,
    seq: latestSeq + index + 1,
    eventType: change.eventType,
    actorType: actor.agentId ? "agent" : "user",
    actorName: browserSenderHandle(actor) ?? null,
    payload: change.payload,
  }));
}

const handleName = (handle: string) => handle.replace(/^@/, "");

async function indexedRequestId(requestId: string, index: number) {
  if (index === 0) return requestId;
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${requestId}:${index}`)),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Canonical authorization and transaction seam for message-backed Tasks. */
export class TaskBoard {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: Dependencies = {},
  ) {}

  /**
   * Every open Task of the Workspace the user can see, then the latest `finished` Done and the
   * latest Closed ones (most recently changed first), and whether older finished ones exist.
   */
  async overview(
    workspaceId: string,
    userId: string,
    { finished = FINISHED_TASKS_PAGE }: { finished?: number } = {},
  ): Promise<TaskOverview> {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");

    const visible = {
      workspaceId,
      conversation: {
        // Tasks in a channel hidden from the Workspace leave the overview until it is restored.
        ...VISIBLE_CONVERSATION_WHERE,
        OR: [
          { channelName: { not: null } },
          {
            directKey: { not: null },
            members: { some: { userId, ...ACTIVE_MEMBER_WHERE } },
            AND: { members: { some: { agentId: { not: null }, ...ACTIVE_MEMBER_WHERE } } },
          },
        ],
      },
    } satisfies Prisma.TaskWhereInput;
    const select = {
      ...taskSelection,
      conversation: {
        select: {
          channelName: true,
          project: { select: { id: true, name: true, slug: true } },
          members: {
            where: { OR: [{ userId }, { agentId: { not: null } }] },
            select: {
              id: true,
              userId: true,
              agent: { select: { id: true, name: true, displayName: true } },
            },
          },
        },
      },
    } satisfies Prisma.TaskSelect;
    // One more than listed says whether older ones exist.
    const latest = (status: "done" | "closed") =>
      this.db.task.findMany({
        where: { ...visible, status },
        orderBy: [{ updatedAt: "desc" }, { messageId: "asc" }],
        take: finished + 1,
        select,
      });
    const [open, done, closed] = await Promise.all([
      this.db.task.findMany({
        where: { ...visible, status: { notIn: ["done", "closed"] } },
        orderBy: { createdAt: "asc" },
        select,
      }),
      latest("done"),
      latest("closed"),
    ]);
    const tasks = [...open, ...done.slice(0, finished), ...closed.slice(0, finished)];

    return {
      tasks: tasks.map((task) => {
        const channelName = task.conversation.channelName;
        const agent =
          task.conversation.members.find((member) => member.agent !== null)?.agent ?? null;
        const currentMemberId =
          task.conversation.members.find((member) => member.userId === userId)?.id ?? null;
        if (channelName === null && agent === null) throw new AppError("INTERNAL_ERROR");
        return {
          ...view(task),
          currentMemberId,
          source: channelName
            ? { channelName, agentId: null, label: `#${channelName}` }
            : {
                channelName: null,
                agentId: agent!.id,
                label: agent!.displayName || agent!.name,
              },
          project: task.conversation.project,
        };
      }),
      more: { done: done.length > finished, closed: closed.length > finished },
    };
  }

  async execute(principal: TaskPrincipal, command: TaskCommand): Promise<TaskResult> {
    this.validateCommand(command);
    if (command.operation === "list" && command.mine && principal.agentId) {
      const tasks = await this.db.task.findMany({
        where: {
          workspaceId: principal.workspaceId,
          owner: { agentId: principal.agentId },
          status:
            command.status === "all"
              ? undefined
              : (command.status ?? { notIn: ["done", "closed"] }),
          conversation: {
            ...VISIBLE_CONVERSATION_WHERE,
            members: { some: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE } },
          },
        },
        orderBy: [{ conversationId: "asc" }, { number: "asc" }],
        select: {
          ...taskSelection,
          conversation: {
            select: {
              channelName: true,
              members: {
                where: { userId: { not: null } },
                select: { user: { select: { username: true } } },
              },
            },
          },
        },
      });
      return {
        tasks: tasks.map((task) => ({
          ...view(task),
          channelRef: task.conversation.channelName
            ? `#${task.conversation.channelName}`
            : `@${task.conversation.members[0]!.user!.username}`,
        })),
      };
    }
    const scope = await this.scope(principal, command);
    if (scope.channel && !scope.member && command.operation !== "list")
      throw new AppError("ACCESS_DENIED");
    if (!scope.member && !scope.channel) throw new AppError("ACCESS_DENIED");

    if (command.operation === "list") {
      const tasks = await this.db.task.findMany({
        where: {
          conversationId: scope.conversationId,
          status: command.status === "all" ? undefined : command.status,
        },
        orderBy: { number: "asc" },
        select: taskSelection,
      });
      return { tasks: tasks.map(view) };
    }
    const member = scope.member!;
    if (command.operation === "create") return this.create(scope, member, principal, command);
    if (command.operation === "convert") return this.convertOrClaim(scope, member, command, false);
    if (command.operation === "claim") return this.claim(scope, member, command);
    if (command.operation === "unclaim") return this.unclaim(scope.conversationId, member, command);
    if (command.operation === "assign") return this.assign(scope, member, command);
    if (command.operation === "unassign") return this.unassign(scope, member, command);
    if (command.operation === "amend") return this.amend(scope.conversationId, member, command);
    if (command.operation === "history") return this.history(scope.conversationId, command);
    if (command.operation === "delete")
      return this.delete(scope.conversationId, scope.workspaceId, member, command);
    if (command.operation === "receipt")
      return this.receipt(scope.conversationId, scope.workspaceId, member, command);
    return this.update(scope, member, command);
  }

  private validateCommand(command: TaskCommand) {
    const operations = [
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
    ];
    if (!operations.includes(command.operation) || !command.idempotencyKey)
      throw new AppError("INVALID_INPUT");
    if ((command.conversationId ? 1 : 0) + (command.target ? 1 : 0) + (command.mine ? 1 : 0) !== 1)
      throw new AppError("INVALID_INPUT");
    if (command.target?.includes(":")) throw new AppError("INVALID_INPUT");
    if (
      command.number !== undefined &&
      (!Number.isSafeInteger(command.number) || command.number < 1)
    )
      throw new AppError("INVALID_INPUT");
    if (
      command.expectedRevision !== undefined &&
      (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)
    )
      throw new AppError("INVALID_INPUT");
    if (
      command.status !== undefined &&
      !["all", "todo", "in_progress", "in_review", "done", "closed"].includes(command.status)
    )
      throw new AppError("INVALID_INPUT");
    if (command.status === "all" && command.operation !== "list")
      throw new AppError("INVALID_INPUT");
    if (command.numbers?.some((number) => !Number.isSafeInteger(number) || number < 1))
      throw new AppError("INVALID_INPUT");
    if (command.messageIds?.some((messageId) => !messageId.trim()))
      throw new AppError("INVALID_INPUT");
    if (
      command.operation !== "update" &&
      command.operation !== "unclaim" &&
      command.operation !== "assign" &&
      command.operation !== "unassign" &&
      command.operation !== "amend" &&
      command.expectedRevision !== undefined
    )
      throw new AppError("INVALID_INPUT");
    if (command.operation === "unassign" && command.assignee !== undefined)
      throw new AppError("INVALID_INPUT");
    if (
      command.operation !== "update" &&
      command.operation !== "list" &&
      command.status !== undefined
    )
      throw new AppError("INVALID_INPUT");
    if (command.operation === "create") {
      const titles = command.titles ?? (command.title === undefined ? [] : [command.title]);
      if (
        titles.length === 0 ||
        (command.title !== undefined && command.titles !== undefined) ||
        titles.some((value) => !value.trim() || value.trim().length > 8_000)
      )
        throw new AppError("INVALID_INPUT");
      if (command.number !== undefined || command.messageId !== undefined)
        throw new AppError("INVALID_INPUT");
    }
    if (command.operation === "amend") {
      if (
        command.title !== undefined &&
        (typeof command.title !== "string" ||
          !command.title.trim() ||
          command.title.trim().length > 10_000)
      )
        throw new AppError("INVALID_INPUT");
      if (
        command.description !== undefined &&
        command.description !== null &&
        (typeof command.description !== "string" || command.description.length > 50_000)
      )
        throw new AppError("INVALID_INPUT");
    }
    if (
      ["unclaim", "update", "assign", "unassign", "amend", "history", "delete", "receipt"].includes(
        command.operation,
      ) &&
      !command.number
    )
      throw new AppError("INVALID_INPUT");
    if (command.operation === "update" && !command.status) throw new AppError("INVALID_INPUT");
    if (
      ["convert", "claim"].includes(command.operation) &&
      !command.number &&
      !command.messageId &&
      !command.numbers?.length &&
      !command.messageIds?.length
    )
      throw new AppError("INVALID_INPUT");
    if (command.operation !== "claim" && (command.numbers || command.messageIds))
      throw new AppError("INVALID_INPUT");
  }

  private async scope(principal: TaskPrincipal, command: TaskCommand) {
    if ((principal.userId ? 1 : 0) + (principal.agentId ? 1 : 0) !== 1)
      throw new AppError("ACCESS_DENIED");
    if (principal.userId) {
      if (command.target || !command.conversationId) throw new AppError("INVALID_INPUT");
      const workspaceMember = await this.db.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: principal.workspaceId,
            userId: principal.userId,
          },
        },
      });
      if (!workspaceMember) throw new AppError("ACCESS_DENIED");
      const conversation = await this.db.conversation.findFirst({
        where: {
          id: command.conversationId,
          workspaceId: principal.workspaceId,
          ...VISIBLE_CONVERSATION_WHERE,
        },
        select: {
          id: true,
          workspaceId: true,
          channelName: true,
          directKey: true,
          // Someone who left the conversation is no longer its member and cannot act on its Tasks.
          members: {
            where: { userId: principal.userId, ...ACTIVE_MEMBER_WHERE },
            select: MEMBER_SELECT,
          },
        },
      });
      if (!conversation) throw new AppError("NOT_FOUND");
      if (
        conversation.directKey !== null &&
        !conversation.directKey.split(":").includes(principal.userId)
      )
        throw new AppError("ACCESS_DENIED");
      return {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        channel: conversation.channelName !== null,
        channelName: conversation.channelName,
        member: conversation.members[0],
      };
    }
    const agent = await this.db.agent.findFirst({
      where: { id: principal.agentId, workspaceId: principal.workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { id: true },
    });
    if (!agent) throw new AppError("ACCESS_DENIED");
    if (command.conversationId || !command.target) throw new AppError("INVALID_INPUT");
    const target = command.target!;
    if (!/^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target) && !/^@[a-z0-9][a-z0-9_-]{0,31}$/.test(target))
      throw new AppError("INVALID_INPUT");
    const targetUser = target.startsWith("@")
      ? await this.db.user.findFirst({
          where: {
            username: target.slice(1),
            memberships: { some: { workspaceId: principal.workspaceId } },
          },
          select: { id: true },
        })
      : null;
    if (target.startsWith("@") && !targetUser) throw new AppError("NOT_FOUND");
    const conversation = target.startsWith("#")
      ? await this.db.conversation.findFirst({
          where: {
            workspaceId: principal.workspaceId,
            channelName: target.slice(1),
            ...VISIBLE_CONVERSATION_WHERE,
            members: { some: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE } },
          },
          select: {
            id: true,
            workspaceId: true,
            channelName: true,
            members: {
              where: { agentId: principal.agentId },
              select: MEMBER_SELECT,
            },
          },
        })
      : await this.db.conversation.findFirst({
          where: {
            workspaceId: principal.workspaceId,
            directKey: { not: null },
            AND: [
              { members: { some: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE } } },
              {
                members: {
                  some: { user: { username: target.slice(1) }, ...ACTIVE_MEMBER_WHERE },
                },
              },
            ],
          },
          select: {
            id: true,
            workspaceId: true,
            channelName: true,
            members: {
              where: { agentId: principal.agentId },
              select: MEMBER_SELECT,
            },
          },
        });
    if (!conversation) throw new AppError("NOT_FOUND");
    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      channel: conversation.channelName !== null,
      channelName: conversation.channelName,
      member: conversation.members[0],
    };
  }

  /** The conversation member a `@handle` names, whether it is a user or an Agent. */
  private memberByHandle(
    tx: Transaction,
    conversationId: string,
    workspaceId: string,
    handle: string,
  ) {
    const name = handleName(handle);
    return tx.conversationMember.findFirst({
      where: {
        conversationId,
        workspaceId,
        // A deleted Agent (or anyone who left) is not an assignable member. Without
        // this, a deleted Agent stayed a valid Task assignee and still received delivery rows.
        ...ACTIVE_MEMBER_WHERE,
        OR: [{ user: { username: name } }, { agent: { name, ...ACTIVE_AGENT_WHERE } }],
      },
      select: {
        id: true,
        userId: true,
        agentId: true,
        user: { select: { username: true } },
        agent: { select: { name: true } },
      },
    });
  }

  /**
   * Any human member of the conversation may hand a Task to someone else or take it off its
   * holder, as a Linear member reassigns an issue; an Agent changes only its own assignment.
   */
  private requireHuman(member: Member) {
    if (!member.userId) throw new AppError("ACCESS_DENIED");
  }

  /** Only Workspace owners and admins may delete or record receipts on Tasks they do not hold. */
  private async requireManager(tx: Transaction, workspaceId: string, member: Member) {
    const membership = member.userId
      ? await tx.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: member.userId } },
          select: { role: true },
        })
      : null;
    if (membership?.role !== "owner" && membership?.role !== "admin")
      throw new AppError("ACCESS_DENIED");
  }

  /**
   * Apply one optimistic Task change and record it in history: `before` is the row the caller
   * read, and it (plus `guard`) must still match — revision included — or the change is a
   * CONFLICT. The guarded write holds the Task row, so history numbering cannot race.
   */
  private async commitTaskChange(
    tx: Transaction,
    actor: Member,
    before: SelectedTask,
    guard: Prisma.TaskWhereInput,
    data: Prisma.TaskUncheckedUpdateManyInput,
  ) {
    const changed = await tx.task.updateMany({
      where: { messageId: before.messageId, revision: before.revision, ...guard },
      data: { ...data, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new AppError("CONFLICT");
    const task = await tx.task.findUniqueOrThrow({
      where: { messageId: before.messageId },
      select: taskSelection,
    });
    const changes = taskChanges(before, task);
    if (!changes.length) return { task, events: [] };
    const latest = await tx.taskHistoryEvent.findFirst({
      where: { taskMessageId: task.messageId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const events = await tx.taskHistoryEvent.createManyAndReturn({
      data: historyRows(task.messageId, actor, changes, latest?.seq ?? 0),
    });
    return { task, events };
  }

  /** Push a committed message to every Agent it was delivered to. Failures never surface. */
  private async publishDeliveries(
    message: {
      id: string;
      workspaceId: string;
      conversationId: string;
      sequence: number;
      body: string;
      mentions: readonly MessageMentionRef[];
      deliveries: Array<{
        deliveryId: string;
        agentId: string;
        agent: { computerId: string | null };
      }>;
    },
    requestId: string,
    target: string,
    sender: AgentMessageSender,
  ) {
    const publisher = this.dependencies.publisher;
    if (!publisher) return;
    await Promise.allSettled(
      message.deliveries.flatMap((delivery) =>
        delivery.agent.computerId
          ? [
              // Deferred so a synchronous publisher failure settles like an async one.
              Promise.resolve().then(() =>
                publisher.publish(
                  daemonControlChannel(message.workspaceId, delivery.agent.computerId!),
                  encodeAgentDelivery({
                    requestId,
                    workspaceId: message.workspaceId,
                    conversationId: message.conversationId,
                    agentId: delivery.agentId,
                    messageId: message.id,
                    deliveryId: delivery.deliveryId,
                    sequence: message.sequence,
                    body: message.body,
                    mentions: message.mentions,
                    target,
                    latestSenderKind: sender.kind,
                    latestSenderHandle: sender.handle,
                    latestSenderDescription: sender.description,
                    // Task deliveries are directed at this Agent; treat as a personal wake.
                    mentionsAgent: true,
                  }),
                ),
              ),
            ]
          : [],
      ),
    );
  }

  private async create(
    scope: {
      conversationId: string;
      workspaceId: string;
      channel: boolean;
      channelName: string | null;
    },
    member: Member,
    principal: TaskPrincipal,
    command: TaskCommand,
  ) {
    const titles = (command.titles ?? [command.title!]).map((title) => title.trim());
    const requestIds = await Promise.all(
      titles.map((_, index) => indexedRequestId(command.idempotencyKey, index)),
    );
    const receiptId = await indexedRequestId(
      `${member.id}:create:${command.idempotencyKey}:assignment`,
      1,
    );
    const result = await this.withNotices(scope, async (tx, notices) => {
      const retried = await tx.task.findMany({
        where: {
          conversationId: scope.conversationId,
          creatorMemberId: member.id,
          requestId: { in: requestIds },
        },
        orderBy: { number: "asc" },
        select: taskSelection,
      });
      if (retried.length) {
        if (retried.length !== titles.length) throw new AppError("CONFLICT");
        const receipt = await tx.message.findUnique({ where: { id: receiptId } });
        const assignee =
          receipt && command.assignee
            ? await this.memberByHandle(
                tx,
                scope.conversationId,
                scope.workspaceId,
                command.assignee,
              )
            : null;
        return {
          tasks: retried,
          created: false,
          sequences: [] as number[],
          receipt,
          started: assignee?.id === member.id,
        };
      }
      if (command.attachmentId) {
        if (!principal.userId) throw new AppError("ACCESS_DENIED");
        const attachment = await tx.attachment.findFirst({
          where: {
            id: command.attachmentId,
            conversationId: scope.conversationId,
            workspaceId: scope.workspaceId,
            uploaderId: principal.userId,
            messageId: null,
          },
        });
        if (!attachment) throw new AppError("ACCESS_DENIED");
      }
      const lastMessage = await tx.message.findFirst({
        where: { conversationId: scope.conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const allocated = await tx.$queryRaw<Array<{ first: number }>>`
        UPDATE "conversations"
        SET "nextTaskNumber" = "nextTaskNumber" + ${titles.length}
        WHERE "id" = ${scope.conversationId}::uuid
        RETURNING "nextTaskNumber" - ${titles.length} AS "first"
      `;
      const firstTaskNumber = allocated[0]?.first;
      if (firstTaskNumber === undefined) throw new AppError("NOT_FOUND");
      const firstSequence = (lastMessage?.sequence ?? 0) + 1;
      // A human's Task wakes the conversation's Agents: in a DM its Agent, in a channel every
      // unmuted Agent plus each muted Agent the Task's own title mentions. An Agent's Task wakes
      // nobody. Never deliver a Task to a deleted Agent.
      const agentMembers = member.userId
        ? await tx.conversationMember.findMany({
            where: {
              conversationId: scope.conversationId,
              agentId: { not: null },
              ...ACTIVE_MEMBER_WHERE,
              agent: ACTIVE_AGENT_WHERE,
            },
            select: { agentId: true, channelMuted: true },
          })
        : [];
      // A title is a message like any other: its mentions, `task #N`s and `#channel`s are stored as
      // tokens, resolved against the channel's active members (a DM keeps plain `@handle` text).
      const mentionTargets = scope.channel
        ? (
            await tx.conversationMember.findMany({
              where: { conversationId: scope.conversationId, ...ACTIVE_MEMBER_WHERE },
              select: {
                id: true,
                userId: true,
                agentId: true,
                user: { select: { username: true } },
                agent: { select: { name: true } },
              },
            })
          ).map((target) =>
            target.userId
              ? {
                  key: target.id,
                  type: "user" as const,
                  id: target.userId,
                  handle: target.user!.username,
                }
              : {
                  key: target.id,
                  type: "agent" as const,
                  id: target.agentId!,
                  handle: target.agent!.name,
                },
          )
        : [];
      const assignee = command.assignee
        ? await this.memberByHandle(tx, scope.conversationId, scope.workspaceId, command.assignee)
        : null;
      if (command.assignee && !assignee) throw new AppError("NOT_FOUND");
      if (assignee && assignee.id !== member.id) this.requireHuman(member);
      const started = assignee?.id === member.id;
      const tasks: SelectedTask[] = [];
      const sequences: number[] = [];
      for (const [index, title] of titles.entries()) {
        const sequence = firstSequence + index;
        const stored = await storeMessageBody(tx, scope, title, { targets: mentionTargets });
        const mentionedAgentIds = new Set(
          stored.mentions
            .filter((mention) => mention.type === "agent")
            .map((mention) => mention.id),
        );
        const recipients = agentMembers.filter(
          ({ agentId, channelMuted }) =>
            !scope.channel || !channelMuted || mentionedAgentIds.has(agentId!),
        );
        const message = await tx.message.create({
          data: {
            conversationId: scope.conversationId,
            workspaceId: scope.workspaceId,
            senderMemberId: member.id,
            body: stored.body,
            sequence,
            mentions: stored.mentions.length
              ? {
                  create: stored.mentions.map((mention) => ({
                    memberId: mention.key,
                    workspaceId: scope.workspaceId,
                    kind: mention.type,
                    actorId: mention.id,
                    handle: mention.handle,
                  })),
                }
              : undefined,
            deliveries: {
              create: recipients.map(({ agentId }) => ({
                workspaceId: scope.workspaceId,
                conversationId: scope.conversationId,
                agentId: agentId!,
                sequence,
              })),
            },
            task: {
              create: {
                workspaceId: scope.workspaceId,
                number: firstTaskNumber + index,
                // The Task's title is its message's stored body, as a converted Task's is; `view`
                // reads its tokens back as text with the message's mention rows.
                title: stored.body,
                description: command.description,
                createsResource: command.createsResource ?? false,
                ownerMemberId: assignee?.id,
                status: started ? "in_progress" : "todo",
                claimedAt: started ? new Date() : null,
                creatorMemberId: member.id,
                requestId: requestIds[index],
              },
            },
          },
          select: { id: true, task: { select: taskSelection } },
        });
        // Task creation stays single-attachment (out of scope for the multi-attachment change);
        // only the first created message (when titles.length > 1) may carry the one attachment.
        if (index === 0 && command.attachmentId)
          await tx.attachment.update({
            where: { id: command.attachmentId },
            data: { messageId: message.id, position: 0 },
          });
        tasks.push(message.task!);
        sequences.push(sequence);
      }
      await tx.taskHistoryEvent.createMany({
        data: tasks.flatMap((task) =>
          historyRows(task.messageId, member, creationChanges(task), 0),
        ),
      });
      const quoted = await notices.quote(tasks);
      await notices.inConversation(noticeText.created(quoted));
      // The assignee's receipt, started or only reserved: one assignment notice in the
      // conversation, with its fixed id and its one delivery to an Agent assignee.
      const receipt = assignee
        ? await notices.receipt({
            id: receiptId,
            body: noticeText.assigned(assigneeMention(assignee), quoted),
            assignee,
          })
        : null;
      return { tasks, created: true, sequences, receipt, started };
    });
    if (result.created) {
      // PostgreSQL is canonical: a missed notification, realtime event or daemon push is
      // repaired by the normal recovery paths, so none of these may fail the committed Tasks.
      // Each effect swallows its own failure as soon as it is created, so a rejection
      // while the delivery rows are still being read is never left unhandled.
      const attempt = (effect: () => unknown) =>
        Promise.resolve()
          .then(effect)
          .catch(() => undefined);
      const scopes = await conversationSignalScopes(
        this.db,
        scope.conversationId,
        scope.workspaceId,
      );
      const signalScope = scopes.message;
      const effects: Promise<unknown>[] = [
        this.announceTasks(scope, async () => scopes.task, {
          tasks: result.tasks.map(view),
          publicationId: `${result.tasks[0]!.messageId}:task-created`,
        }),
      ];
      effects.push(
        ...result.tasks.flatMap((task, index) => [
          ...(member.userId
            ? [attempt(() => this.dependencies.notifications?.notifyMessage(task.messageId))]
            : []),
          attempt(() =>
            this.dependencies.realtime?.messageAvailable({
              conversationId: scope.conversationId,
              messageId: task.messageId,
              sequence: result.sequences[index]!,
              ...signalScope,
            }),
          ),
        ]),
      );
      if (member.userId && this.dependencies.publisher) {
        const messages = await this.db.message.findMany({
          where: { id: { in: result.tasks.map((task) => task.messageId) } },
          include: {
            sender: MESSAGE_SENDER_SELECT,
            mentions: MESSAGE_MENTIONS_SELECT,
            deliveries: { include: { agent: { select: { computerId: true } } } },
          },
        });
        for (const message of messages) {
          const sender = agentMessageSender(message.sender);
          effects.push(
            this.publishDeliveries(
              message,
              command.idempotencyKey,
              scope.channelName ? `#${scope.channelName}` : `@${sender.handle}`,
              sender,
            ),
          );
        }
      }
      await Promise.all(effects);
      if (result.receipt)
        await this.publishAssignmentReceipt(result.receipt.id, command.idempotencyKey);
    }
    const { receipt } = result;
    return {
      tasks: result.tasks.map(view),
      ...(receipt && {
        assignmentReceipt: {
          messageId: receipt.id,
          content: receipt.body,
          assignee: command.assignee!,
          state: result.started ? ("started" as const) : ("assigned" as const),
        },
      }),
    };
  }

  /**
   * Run one Task change in a transaction that holds the conversation row lock (shared with
   * ordinary sends, since a notice takes the next message sequence), then tell open pages about
   * the notices it posted. Every Task write that posts a notice goes through here, so neither the
   * lock nor the signal can be left out.
   */
  private async withNotices<T>(
    conversation: ConversationRef,
    change: (tx: Transaction, notices: NoticeWriter) => Promise<T>,
  ): Promise<T> {
    const posted: PostedNotice[] = [];
    const result = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversation.conversationId);
      const post = (input: NoticeInput) => this.writeNotice(tx, conversation, input);
      const postAndSignal = async (input: NoticeInput) => {
        const notice = await post(input);
        posted.push(notice);
        return notice;
      };
      const quote = async (tasks: readonly NoticeSubject[]) => {
        const mentions = await tx.messageMention.findMany({
          where: { messageId: { in: tasks.map((task) => task.messageId) } },
          select: { messageId: true, kind: true, actorId: true, handle: true },
        });
        return tasks.map((task) =>
          quotedTask(
            task,
            mentions.filter((mention) => mention.messageId === task.messageId),
          ),
        );
      };
      return change(tx, {
        quote,
        inConversation: (body) => postAndSignal({ body }),
        inThread: async (task, body) => {
          const [quoted] = await quote([task]);
          return postAndSignal({ body: body(quoted!), threadRootId: task.messageId });
        },
        receipt: ({ assignee, ...input }) =>
          post({ ...input, deliverTo: assignee.agentId, mentions: assignee }),
      });
    });
    await this.signalNotices(posted);
    return result;
  }

  /** Post one server notice (a null sender); only a receipt mentions a member and names the Agent
   * it is delivered to. */
  private async writeNotice(
    tx: Transaction,
    conversation: ConversationRef,
    input: NoticeInput,
  ): Promise<PostedNotice> {
    const latest = await tx.message.findFirst({
      where: { conversationId: conversation.conversationId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (latest?.sequence ?? 0) + 1;
    // Named fields only: callers pass wider scope objects that are also a ConversationRef.
    const { conversationId, workspaceId } = conversation;
    return tx.message.create({
      data: {
        id: input.id,
        conversationId,
        workspaceId,
        threadRootId: input.threadRootId,
        body: input.body,
        sequence,
        mentions: input.mentions
          ? {
              create: {
                memberId: input.mentions.id,
                workspaceId,
                kind: input.mentions.agentId ? "agent" : "user",
                actorId: input.mentions.agentId ?? input.mentions.userId!,
                handle: input.mentions.agent?.name ?? input.mentions.user!.username,
              },
            }
          : undefined,
        deliveries: input.deliverTo
          ? { create: { conversationId, workspaceId, agentId: input.deliverTo, sequence } }
          : undefined,
      },
      select: {
        id: true,
        conversationId: true,
        workspaceId: true,
        sequence: true,
        threadRootId: true,
        body: true,
      },
    });
  }

  /**
   * Tell the conversation's open pages about committed notices. Only that per-conversation
   * signal: notices never count as unread, so the Workspace/user channel that drives sidebar
   * badges is left out, and they wake and push no one.
   */
  private async signalNotices(notices: readonly PostedNotice[]) {
    const realtime = this.dependencies.realtime;
    if (!realtime) return;
    await Promise.allSettled(
      notices.map((notice) =>
        Promise.resolve().then(() =>
          realtime.messageAvailable({
            conversationId: notice.conversationId,
            messageId: notice.id,
            sequence: notice.sequence,
            ...(notice.threadRootId && { threadRootId: notice.threadRootId }),
          }),
        ),
      ),
    );
  }

  private async publishAssignmentReceipt(messageId: string, requestId: string) {
    const message = await this.db.message.findUniqueOrThrow({
      where: { id: messageId },
      include: {
        conversation: {
          select: {
            channelName: true,
            members: {
              where: { userId: { not: null } },
              take: 1,
              select: { user: { select: { username: true } } },
            },
          },
        },
        mentions: MESSAGE_MENTIONS_SELECT,
        deliveries: { include: { agent: { select: { computerId: true } } } },
      },
    });
    const signalScope = await messageSignalScope(
      this.db,
      message.conversationId,
      message.workspaceId,
    );
    // A failed notification never rolls back or misreports a committed assignment.
    await Promise.allSettled([
      Promise.resolve().then(() =>
        this.dependencies.realtime?.messageAvailable({
          conversationId: message.conversationId,
          messageId: message.id,
          sequence: message.sequence,
          ...signalScope,
        }),
      ),
      Promise.resolve().then(() => this.dependencies.notifications?.notifyMessage(message.id)),
      this.publishDeliveries(
        message,
        requestId,
        message.conversation.channelName
          ? `#${message.conversation.channelName}`
          : `@${message.conversation.members[0]!.user!.username}`,
        agentMessageSender(null),
      ),
    ]);
  }

  private async findMessage(tx: Transaction, conversationId: string, messageId: string) {
    // An eight-character id is the uuid range it names, so the lookup stays an index range on the
    // message id instead of reading every top-level message in the conversation.
    const messages = await tx.message.findMany({
      where:
        messageId.length === 8 && /^[0-9a-f]{8}$/i.test(messageId)
          ? channelThreadRootWhere(conversationId, messageId)
          : { conversationId, threadRootId: null, id: messageId },
      take: 2,
      select: { id: true, body: true },
    });
    if (messages.length !== 1) throw new AppError(messages.length ? "CONFLICT" : "NOT_FOUND");
    return messages[0]!;
  }

  private async convertOrClaim(
    conversation: ConversationRef,
    member: Member,
    command: TaskCommand,
    claim: boolean,
  ) {
    const { conversationId, workspaceId } = conversation;
    const task = await this.withNotices(conversation, async (tx, notices) => {
      let existing = command.number
        ? await tx.task.findUnique({
            where: {
              conversationId_number: { conversationId, number: command.number },
            },
            select: taskSelection,
          })
        : undefined;
      let message: { id: string; body: string } | undefined;
      if (!existing && command.messageId) {
        message = await this.findMessage(tx, conversationId, command.messageId);
        existing =
          (await tx.task.findUnique({
            where: { messageId: message.id },
            select: taskSelection,
          })) ?? undefined;
      }
      if (!existing) {
        if (!message) throw new AppError("NOT_FOUND");
        const allocated = await tx.$queryRaw<Array<{ number: number }>>`
          UPDATE "conversations"
          SET "nextTaskNumber" = "nextTaskNumber" + 1
          WHERE "id" = ${conversationId}::uuid
          RETURNING "nextTaskNumber" - 1 AS "number"
        `;
        if (allocated[0]?.number === undefined) throw new AppError("NOT_FOUND");
        existing = await tx.task.create({
          data: {
            messageId: message.id,
            conversationId,
            workspaceId,
            number: allocated[0].number,
            title: message.body.slice(0, 8_000),
            creatorMemberId: member.id,
          },
          select: taskSelection,
        });
        await tx.taskHistoryEvent.createMany({
          data: historyRows(existing.messageId, member, creationChanges(existing), 0),
        });
        const [quoted] = await notices.quote([existing]);
        await notices.inConversation(
          noticeText.converted(noticeActor(member).displayName, quoted!),
        );
      }
      if (!claim) return existing;
      if (
        existing.ownerMemberId === member.id &&
        (existing.status === "in_progress" || existing.status === "in_review")
      )
        return existing;
      if (existing.status === "done" || existing.status === "closed")
        throw new AppError("CONFLICT");
      if (existing.ownerMemberId && existing.ownerMemberId !== member.id)
        throw new AppError("CONFLICT");
      const { task: claimed } = await this.commitTaskChange(
        tx,
        member,
        existing,
        { ownerMemberId: existing.ownerMemberId, status: existing.status },
        {
          ownerMemberId: member.id,
          claimedAt: new Date(),
          status: existing.status === "todo" ? "in_progress" : existing.status,
        },
      );
      // Claiming a Todo Task also moves it to In Progress; the claim notice says both.
      await notices.inThread(claimed, (quoted) =>
        noticeText.claimed(noticeActor(member).handle, quoted),
      );
      return claimed;
    });
    await this.signalTaskChange(task);
    return { tasks: [view(task)] };
  }

  private async claim(
    conversation: ConversationRef,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    const selectors: Array<{ number?: number; messageId?: string }> = [
      ...Array.from(
        new Set([...(command.numbers ?? []), ...(command.number ? [command.number] : [])]),
        (number) => ({ number }),
      ),
      ...Array.from(
        new Set([...(command.messageIds ?? []), ...(command.messageId ? [command.messageId] : [])]),
        (messageId) => ({ messageId }),
      ),
    ];
    if (selectors.length === 1) {
      const result = await this.convertOrClaim(
        conversation,
        member,
        { ...command, number: selectors[0]!.number, messageId: selectors[0]!.messageId },
        true,
      );
      const task = result.tasks[0]!;
      return {
        ...result,
        claims: [{ number: task.number, messageId: task.messageId, success: true }],
      };
    }

    const tasks: TaskView[] = [];
    const claims: NonNullable<TaskResult["claims"]> = [];
    for (const selector of selectors) {
      try {
        const result = await this.convertOrClaim(
          conversation,
          member,
          {
            ...command,
            numbers: undefined,
            messageIds: undefined,
            number: undefined,
            messageId: undefined,
            ...selector,
          },
          true,
        );
        const task = result.tasks[0]!;
        tasks.push(task);
        claims.push({
          number: task.number,
          messageId: task.messageId,
          success: true,
        });
      } catch (error) {
        claims.push({
          ...selector,
          success: false,
          reason: error instanceof Error ? error.message : "claim failed",
        });
      }
    }
    return { tasks, claims };
  }

  private async unclaim(conversationId: string, member: Member, command: TaskCommand) {
    const task = await this.db.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: taskSelection,
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (task.ownerMemberId !== member.id) throw new AppError("ACCESS_DENIED");
    if (task.status === "done") throw new AppError("CONFLICT");
    const { task: updated } = await this.db.$transaction((tx) =>
      this.commitTaskChange(
        tx,
        member,
        task,
        {
          revision: command.expectedRevision ?? task.revision,
          ownerMemberId: member.id,
          status: { not: "done" },
        },
        { ownerMemberId: null, claimedAt: null },
      ),
    );
    await this.signalTaskChange(updated);
    return { tasks: [view(updated)] };
  }

  private async update(conversation: ConversationRef, member: Member, command: TaskCommand) {
    const { conversationId } = conversation;
    const task = await this.db.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: taskSelection,
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (command.expectedRevision !== undefined && task.revision !== command.expectedRevision)
      throw new AppError("CONFLICT");
    const isOwner = task.ownerMemberId === member.id;
    if (member.agentId && !isOwner) throw new AppError("ACCESS_DENIED");
    if (!isOwner && !member.userId) throw new AppError("ACCESS_DENIED");
    if (
      !isOwner &&
      command.status !== "todo" &&
      command.status !== "done" &&
      command.status !== "closed"
    )
      throw new AppError("ACCESS_DENIED");
    if (command.status !== "todo" && command.status !== "closed" && !task.ownerMemberId)
      throw new AppError("CONFLICT");
    if (command.status === "done" && task.createsResource && !task.resourceReceipt)
      throw new AppError("CONFLICT");
    const updated = await this.withNotices(conversation, async (tx, notices) => {
      const { task: updated } = await this.commitTaskChange(
        tx,
        member,
        task,
        { ownerMemberId: task.ownerMemberId },
        { status: command.status },
      );
      if (updated.status !== task.status)
        await notices.inThread(updated, (quoted) =>
          noticeText.moved(
            noticeActor(member).displayName,
            quoted,
            storedTaskStatus(updated.status),
          ),
        );
      return updated;
    });
    await this.signalTaskChange(updated);
    return { tasks: [view(updated)] };
  }

  private async assign(
    conversation: ConversationRef,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    const { conversationId, workspaceId } = conversation;
    if (command.assignee !== null && !command.assignee?.match(/^@[a-z0-9][a-z0-9_-]{0,63}$/))
      throw new AppError("INVALID_INPUT");
    const receiptId = await indexedRequestId(
      `${member.id}:assign:${command.number}:${command.idempotencyKey}:assignment`,
      1,
    );
    const result = await this.withNotices(conversation, async (tx, notices) => {
      const receipt = await tx.message.findUnique({ where: { id: receiptId } });
      if (receipt) {
        const task = await tx.task.findUnique({
          where: { conversationId_number: { conversationId, number: command.number! } },
          select: taskSelection,
        });
        return { task, receipt, changed: false };
      }
      const owner = command.assignee
        ? await this.memberByHandle(tx, conversationId, workspaceId, command.assignee)
        : null;
      if (command.assignee && !owner) throw new AppError("NOT_FOUND");
      const current = await tx.task.findUnique({
        where: {
          conversationId_number: { conversationId, number: command.number! },
        },
        select: taskSelection,
      });
      if (!current) throw new AppError("NOT_FOUND");
      if (
        (owner && owner.id !== member.id) ||
        (current.ownerMemberId && current.ownerMemberId !== member.id)
      )
        this.requireHuman(member);
      if (command.expectedRevision !== undefined && current.revision !== command.expectedRevision)
        throw new AppError("CONFLICT");
      if (current.ownerMemberId === (owner?.id ?? null))
        return { task: current, receipt: null, changed: false };
      const { task } = await this.commitTaskChange(
        tx,
        member,
        current,
        { ownerMemberId: current.ownerMemberId },
        { ownerMemberId: owner?.id ?? null, claimedAt: null },
      );
      if (!owner) {
        await notices.inThread(task, (quoted) =>
          noticeText.unassigned(noticeActor(member).displayName, quoted),
        );
        return { task, changed: true, receipt: null };
      }
      return {
        task,
        changed: true,
        receipt: await notices.receipt({
          id: receiptId,
          body: noticeText.assigned(assigneeMention(owner), await notices.quote([task])),
          assignee: owner,
        }),
      };
    });
    const { task, receipt } = result;
    if (task && result.changed) await this.signalTaskChange(task);
    if (receipt && result.changed)
      await this.publishAssignmentReceipt(receipt.id, command.idempotencyKey);
    return {
      tasks: task ? [view(task)] : [],
      ...(receipt && {
        assignmentReceipt: {
          messageId: receipt.id,
          content: receipt.body,
          assignee: command.assignee!,
          state: "assigned" as const,
        },
      }),
    };
  }

  /**
   * Clear a Task's owner, leaving it open for anyone to claim. A no-op on an already
   * unowned Task returns it unchanged; otherwise this is `assign` with no assignee,
   * minus the assignment receipt, since there is no one to notify.
   */
  private async unassign(
    conversation: ConversationRef,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    const { conversationId } = conversation;
    const result = await this.withNotices(conversation, async (tx, notices) => {
      const current = await tx.task.findUnique({
        where: { conversationId_number: { conversationId, number: command.number! } },
        select: taskSelection,
      });
      if (!current) throw new AppError("NOT_FOUND");
      if (!current.ownerMemberId) return { task: current, changed: false };
      if (current.ownerMemberId !== member.id) this.requireHuman(member);
      if (command.expectedRevision !== undefined && current.revision !== command.expectedRevision)
        throw new AppError("CONFLICT");
      const { task } = await this.commitTaskChange(
        tx,
        member,
        current,
        { ownerMemberId: current.ownerMemberId },
        { ownerMemberId: null, claimedAt: null },
      );
      await notices.inThread(task, (quoted) =>
        noticeText.unassigned(noticeActor(member).displayName, quoted),
      );
      return { task, changed: true };
    });
    if (result.changed) await this.signalTaskChange(result.task);
    return { tasks: [view(result.task)] };
  }

  private async amend(
    conversationId: string,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    if (command.title === undefined && command.description === undefined)
      throw new AppError("INVALID_INPUT");
    const result = await this.db.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: {
          conversationId_number: { conversationId, number: command.number! },
        },
        select: taskSelection,
      });
      if (!task) throw new AppError("NOT_FOUND");
      if (command.expectedRevision !== undefined && task.revision !== command.expectedRevision)
        throw new AppError("CONFLICT");
      // An amended title is typed text. One that reads the same as the current title (whose stored
      // tokens read back as `@handle`, `task #N`, `#name`) is left as stored, tokens included.
      const title = command.title?.trim();
      const retitled =
        title !== undefined && title !== agentReadableBody(task.title, task.message.mentions);
      return this.commitTaskChange(
        tx,
        member,
        task,
        {},
        {
          ...(retitled && { title }),
          ...(command.description !== undefined && { description: command.description }),
        },
      );
    });
    await this.signalTaskChange(result.task);
    return { tasks: [view(result.task)], history: result.events.map(historyEventView) };
  }

  private async history(conversationId: string, command: TaskCommand): Promise<TaskResult> {
    const task = await this.db.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: {
        ...taskSelection,
        creator: { select: TASK_MEMBER_SELECT },
        history: { orderBy: { seq: "asc" } },
      },
    });
    if (!task) throw new AppError("NOT_FOUND");
    return {
      tasks: [{ ...view(task), creator: taskMember(task.workspaceId, task.creator) }],
      history: task.history.map(historyEventView),
    };
  }

  private async delete(
    conversationId: string,
    workspaceId: string,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    const task = await this.db.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: { messageId: true, creatorMemberId: true },
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (task.creatorMemberId !== member.id) await this.requireManager(this.db, workspaceId, member);
    await this.db.task.delete({ where: { messageId: task.messageId } });
    await this.announceTasks(
      { conversationId, workspaceId },
      async () => (await conversationSignalScopes(this.db, conversationId, workspaceId)).task,
      { deleted: [task.messageId], publicationId: `${task.messageId}:task-deleted` },
    );
    return { tasks: [] };
  }

  private async receipt(
    conversationId: string,
    workspaceId: string,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    const receipt = command.receipt;
    if (
      !receipt ||
      Object.values(receipt).some((value) => typeof value !== "string" || !value.trim()) ||
      !receipt.teardownOwner.match(/^@[a-z0-9][a-z0-9_-]{0,63}$/)
    )
      throw new AppError("INVALID_INPUT");
    const fireAt = new Date(receipt.expiry);
    if (!Number.isFinite(fireAt.getTime())) throw new AppError("INVALID_INPUT");

    const result = await this.db.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: {
          conversationId_number: { conversationId, number: command.number! },
        },
        select: {
          ...taskSelection,
          resourceExpiryFollowupId: true,
        },
      });
      if (!task) throw new AppError("NOT_FOUND");
      if (!task.createsResource) throw new AppError("CONFLICT");
      if (task.ownerMemberId !== member.id) await this.requireManager(tx, workspaceId, member);
      const teardownOwner = await tx.agent.findFirst({
        where: {
          workspaceId,
          name: receipt.teardownOwner.slice(1),
          computerId: { not: null },
          ...ACTIVE_AGENT_WHERE,
          conversations: { some: { conversationId } },
        },
        select: { id: true, computerId: true, name: true },
      });
      if (!teardownOwner?.computerId) throw new AppError("NOT_FOUND");
      await tx.$queryRaw`SELECT "id" FROM "agents" WHERE "id" = ${teardownOwner.id}::uuid FOR UPDATE`;
      const workspaceComputer = await tx.workspaceComputer.findUnique({
        where: {
          workspaceId_computerId: {
            workspaceId,
            computerId: teardownOwner.computerId,
          },
        },
        select: { computerId: true },
      });
      if (!workspaceComputer) throw new AppError("ACCESS_DENIED");
      if (task.resourceExpiryFollowupId) {
        const recorded = view(task).resourceReceipt;
        if (
          !recorded ||
          Object.entries(receipt).some(([key, value]) => Reflect.get(recorded, key) !== value)
        )
          throw new AppError("CONFLICT");
        const reminder = await tx.reminder.findUniqueOrThrow({
          where: { id: task.resourceExpiryFollowupId },
        });
        return { task, reminder, owner: teardownOwner };
      }
      if (fireAt <= new Date()) throw new AppError("INVALID_INPUT");
      const activeReminders = await tx.reminder.count({
        where: {
          workspaceId,
          ownerAgentId: teardownOwner.id,
          status: "scheduled",
        },
      });
      if (activeReminders >= MAX_ACTIVE_REMINDERS) throw new AppError("CONFLICT");
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          channelName: true,
          members: {
            where: { userId: { not: null } },
            take: 1,
            select: { user: { select: { username: true } } },
          },
        },
      });
      const baseTarget = conversation.channelName
        ? `#${conversation.channelName}`
        : `@${conversation.members[0]?.user?.username}`;
      if (baseTarget.endsWith("undefined")) throw new AppError("INTERNAL_ERROR");
      const reminder = await tx.reminder.create({
        data: {
          workspaceId,
          ownerAgentId: teardownOwner.id,
          computerId: teardownOwner.computerId,
          title: `Expire resource from task #${task.number}: ${receipt.object}`,
          target: `${baseTarget}:${task.messageId}`,
          messageId: task.messageId,
          fireAt,
          events: {
            create: {
              workspace: { connect: { id: workspaceId } },
              type: "created",
              title: `Expire resource from task #${task.number}`,
              scheduledFor: fireAt,
            },
          },
        },
      });
      const { task: updated } = await this.commitTaskChange(
        tx,
        member,
        task,
        { resourceExpiryFollowupId: null },
        {
          resourceReceipt: receipt,
          resourceReceiptRecordedAt: new Date(),
          resourceTeardownOwnerAgentId: teardownOwner.id,
          resourceExpiryFollowupId: reminder.id,
        },
      );
      return { task: updated, reminder, owner: teardownOwner };
    });
    await this.signalTaskChange(result.task);
    if (this.dependencies.publisher)
      try {
        await this.dependencies.publisher.publish(
          daemonControlChannel(workspaceId, result.reminder.computerId),
          encodeReminderSync({
            protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
            requestId: command.idempotencyKey,
            workspaceId,
            computerId: result.reminder.computerId,
            agentId: result.owner.id,
            operation: "upsert",
            jobs: [
              {
                reminderId: result.reminder.id,
                ownerAgentId: result.owner.id,
                version: result.reminder.version,
                title: result.reminder.title,
                target: result.reminder.target,
                messageId: result.reminder.messageId,
                fireAt: result.reminder.fireAt.toISOString(),
              },
            ],
            messageType: REMINDER_SYNC_MESSAGE_TYPE,
          }),
        );
      } catch {
        // Reminder snapshot reconciliation repairs a missed upsert.
      }
    return {
      tasks: [view(result.task)],
      resourceFollowup: {
        id: result.reminder.id,
        ownerAgentId: result.owner.id,
        owner: `@${result.owner.name}`,
        fireAt: result.reminder.fireAt.toISOString(),
        messageId: result.reminder.messageId,
        conversationId,
      },
    };
  }

  private async signalTaskChange(task: SelectedTask) {
    const realtime = this.dependencies.realtime;
    if (!realtime) return;
    try {
      const scopes = await conversationSignalScopes(this.db, task.conversationId, task.workspaceId);
      await Promise.allSettled([
        Promise.resolve().then(() =>
          realtime.messageAvailable({
            conversationId: task.conversationId,
            messageId: task.messageId,
            sequence: task.message.sequence,
            // Task metadata changes are always top-level messages, never thread replies.
            ...scopes.message,
            publicationId: `${task.messageId}:task:${task.revision}`,
          }),
        ),
        this.announceTasks(task, async () => scopes.task, {
          tasks: [view(task)],
          publicationId: `${task.messageId}:task-changed:${task.revision}`,
        }),
      ]);
    } catch {
      // PostgreSQL is canonical; normal reconciliation repairs a missed metadata event.
    }
  }

  /**
   * Tells open Tasks pages the new copies of the Tasks a write changed, or the ids of those it
   * deleted, where `route` says (nowhere when it names no scope). Its own publication key: the
   * message signal on the same channel has another, since Centrifugo drops a repeated key.
   * Never fails the write, the route's read included.
   */
  private async announceTasks(
    conversation: { conversationId: string; workspaceId: string },
    route: () => Promise<MessageSignalScope | undefined>,
    change: { tasks?: TaskView[]; deleted?: string[]; publicationId: string },
  ) {
    const taskChanged = this.dependencies.realtime?.taskChanged?.bind(this.dependencies.realtime);
    if (!taskChanged) return;
    try {
      const scope = await route();
      if (!scope) return;
      await taskChanged({
        workspaceId: conversation.workspaceId,
        conversationId: conversation.conversationId,
        tasks: change.tasks ?? [],
        deleted: change.deleted ?? [],
        userId: scope.userId,
        agentId: scope.agentId,
        publicationId: change.publicationId,
      });
    } catch {
      // PostgreSQL is canonical: a page that missed it shows the change on its next read.
    }
  }
}
