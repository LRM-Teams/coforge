import { lockConversation } from "../conversations/conversation-lock.server";
import {
  AGENT_MESSAGE_METHOD,
  REMINDER_SYNC_MESSAGE_TYPE,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
  encodeReminderSync,
  type TaskCommand,
  type TaskPrincipal,
  type TaskResult,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { ACTIVE_AGENT_WHERE } from "../agents/active-agent.server";
import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import {
  messageSignalScope,
  type ConversationRealtime,
} from "../conversations/conversation-realtime.server";
import { mentionedNames } from "../conversations/mentions";
import { ACTIVE_MEMBER_WHERE } from "../conversations/active-member.server";
import { daemonControlChannel, type CentrifugoServerApi } from "../centrifugo/server-api.server";
import type { MessageNotifier } from "../notifications/web-push-composition.server";
import { MAX_ACTIVE_REMINDERS } from "../reminders/reminders.server";

type Dependencies = {
  realtime?: ConversationRealtime;
  notifications?: MessageNotifier;
  publisher?: Pick<CentrifugoServerApi, "publish">;
};

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
  owner: {
    select: {
      id: true,
      user: { select: { username: true, displayName: true } },
      agent: { select: { name: true, displayName: true } },
    },
  },
  // The backing message's sequence, so realtime signals need no second read.
  message: { select: { sequence: true } },
} satisfies Prisma.TaskSelect;

type SelectedTask = Prisma.TaskGetPayload<{ select: typeof taskSelection }>;
type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
type Member = { id: string; userId: string | null; agentId: string | null };
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
    }
  >;
};

function status(value: string): TaskStatus {
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

function view(task: SelectedTask): TaskView {
  const resourceReceipt = task.resourceReceipt;
  return {
    messageId: task.messageId,
    conversationId: task.conversationId,
    number: task.number,
    title: task.title,
    description: task.description,
    status: status(task.status),
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
    owner: task.owner
      ? task.owner.agent
        ? {
            memberId: task.owner.id,
            kind: "agent",
            name: task.owner.agent.displayName || task.owner.agent.name,
          }
        : {
            memberId: task.owner.id,
            kind: "user",
            name: task.owner.user?.displayName || `@${task.owner.user?.username}`,
          }
      : null,
  };
}

function historyEventView(event: HistoryEvent) {
  return {
    id: event.id,
    sequence: event.sequence,
    eventType: event.eventType,
    actorKind: event.actorKind as "user" | "agent" | "system",
    actorName: event.actorName,
    beforeTitle: event.beforeTitle ?? undefined,
    afterTitle: event.afterTitle ?? undefined,
    beforeDescription: event.beforeDescription,
    afterDescription: event.afterDescription,
    createdAt: event.createdAt.toISOString(),
  };
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

  async overview(workspaceId: string, userId: string): Promise<TaskOverview> {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");

    const tasks = await this.db.task.findMany({
      where: {
        workspaceId,
        conversation: {
          OR: [
            { channelName: { not: null } },
            {
              directKey: { not: null },
              members: { some: { userId, ...ACTIVE_MEMBER_WHERE } },
              AND: { members: { some: { agentId: { not: null }, ...ACTIVE_MEMBER_WHERE } } },
            },
          ],
        },
      },
      orderBy: { createdAt: "asc" },
      select: {
        ...taskSelection,
        conversation: {
          select: {
            channelName: true,
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
      },
    });

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
        };
      }),
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
    if (command.operation === "convert")
      return this.convertOrClaim(
        scope.conversationId,
        scope.workspaceId,
        member.id,
        command,
        false,
      );
    if (command.operation === "claim")
      return this.claim(scope.conversationId, scope.workspaceId, member.id, command);
    if (command.operation === "unclaim")
      return this.unclaim(scope.conversationId, member.id, command);
    if (command.operation === "assign")
      return this.assign(scope.conversationId, scope.workspaceId, member, command);
    if (command.operation === "unassign")
      return this.unassign(scope.conversationId, scope.workspaceId, member, command);
    if (command.operation === "amend") return this.amend(scope.conversationId, member, command);
    if (command.operation === "history") return this.history(scope.conversationId, command);
    if (command.operation === "delete")
      return this.delete(scope.conversationId, scope.workspaceId, member, command);
    if (command.operation === "receipt")
      return this.receipt(scope.conversationId, scope.workspaceId, member, command);
    return this.update(scope.conversationId, member, command);
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
    if (!operations.includes(command.operation) || !command.requestId)
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
        },
        select: {
          id: true,
          workspaceId: true,
          channelName: true,
          directKey: true,
          members: {
            where: { userId: principal.userId },
            select: { id: true, userId: true, agentId: true },
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
            members: { some: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE } },
          },
          select: {
            id: true,
            workspaceId: true,
            channelName: true,
            members: {
              where: { agentId: principal.agentId },
              select: { id: true, userId: true, agentId: true },
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
              select: { id: true, userId: true, agentId: true },
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
        // ADR 0044/0024: a deleted Agent (or anyone who left) is not an assignable member. Without
        // this, a deleted Agent stayed a valid Task assignee and still received delivery rows.
        ...ACTIVE_MEMBER_WHERE,
        OR: [{ user: { username: name } }, { agent: { name, ...ACTIVE_AGENT_WHERE } }],
      },
      select: { id: true, userId: true, agentId: true },
    });
  }

  /** Only Workspace owners and admins may act on Tasks they do not hold themselves. */
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
   * Apply one optimistic Task change: the guard must still match the row the caller read
   * (revision included) or the change is a CONFLICT. Returns the row as it now stands.
   */
  private async commitTaskChange(
    tx: Transaction,
    guard: Prisma.TaskWhereInput & { messageId: string; revision: number },
    data: Prisma.TaskUncheckedUpdateManyInput,
  ) {
    const changed = await tx.task.updateMany({
      where: guard,
      data: { ...data, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new AppError("CONFLICT");
    return tx.task.findUniqueOrThrow({
      where: { messageId: guard.messageId },
      select: taskSelection,
    });
  }

  /** Push a committed message to every Agent it was delivered to. Failures never surface. */
  private async publishDeliveries(
    message: {
      id: string;
      workspaceId: string;
      conversationId: string;
      sequence: number;
      body: string;
      deliveries: Array<{
        deliveryId: string;
        agentId: string;
        agent: { computerId: string | null };
      }>;
    },
    requestId: string,
    target: string,
    latestSender: string,
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
                  encodeAgentMessageDelivery({
                    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
                    method: AGENT_MESSAGE_METHOD,
                    requestId,
                    workspaceId: message.workspaceId,
                    conversationId: message.conversationId,
                    agentId: delivery.agentId,
                    messageId: message.id,
                    deliveryId: delivery.deliveryId,
                    sequence: message.sequence,
                    body: message.body,
                    target,
                    latestSender,
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
      titles.map((_, index) => indexedRequestId(command.requestId, index)),
    );
    const receiptId = await indexedRequestId(
      `${member.id}:create:${command.requestId}:assignment`,
      1,
    );
    const result = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, scope.conversationId);
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
      const names = mentionedNames(titles.join("\n"));
      const recipients = member.userId
        ? await tx.conversationMember.findMany({
            where: scope.channel
              ? {
                  conversationId: scope.conversationId,
                  agentId: { not: null },
                  // ADR 0044: never deliver a Task to a deleted Agent.
                  ...ACTIVE_MEMBER_WHERE,
                  agent: ACTIVE_AGENT_WHERE,
                  OR: [{ channelMuted: false }, { agent: { name: { in: names } } }],
                }
              : {
                  conversationId: scope.conversationId,
                  agentId: { not: null },
                  ...ACTIVE_MEMBER_WHERE,
                  agent: ACTIVE_AGENT_WHERE,
                },
            select: { agentId: true },
          })
        : [];
      const assignee = command.assignee
        ? await this.memberByHandle(tx, scope.conversationId, scope.workspaceId, command.assignee)
        : null;
      if (command.assignee && !assignee) throw new AppError("NOT_FOUND");
      if (assignee && assignee.id !== member.id)
        await this.requireManager(tx, scope.workspaceId, member);
      const started = assignee?.id === member.id;
      const tasks: SelectedTask[] = [];
      const sequences: number[] = [];
      for (const [index, title] of titles.entries()) {
        const sequence = firstSequence + index;
        const message = await tx.message.create({
          data: {
            conversationId: scope.conversationId,
            workspaceId: scope.workspaceId,
            senderMemberId: member.id,
            body: title,
            sequence,
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
                title,
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
      const receipt = assignee
        ? await this.writeAssignmentReceipt(tx, {
            id: receiptId,
            conversationId: scope.conversationId,
            workspaceId: scope.workspaceId,
            assignee: command.assignee!,
            agentId: assignee.agentId,
            numbers: tasks.map((task) => task.number),
            started,
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
      const signalScope = await messageSignalScope(
        this.db,
        scope.conversationId,
        scope.workspaceId,
      );
      const effects: Promise<unknown>[] = result.tasks.flatMap((task, index) => [
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
      ]);
      if (member.userId && this.dependencies.publisher) {
        const messages = await this.db.message.findMany({
          where: { id: { in: result.tasks.map((task) => task.messageId) } },
          include: {
            sender: { select: { user: { select: { username: true } } } },
            deliveries: { include: { agent: { select: { computerId: true } } } },
          },
        });
        for (const message of messages) {
          const sender = `@${message.sender!.user!.username}`;
          effects.push(
            this.publishDeliveries(
              message,
              command.requestId,
              scope.channelName ? `#${scope.channelName}` : sender,
              sender,
            ),
          );
        }
      }
      await Promise.all(effects);
      if (result.receipt) await this.publishAssignmentReceipt(result.receipt.id, command.requestId);
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

  private async writeAssignmentReceipt(
    tx: Transaction,
    input: {
      id: string;
      conversationId: string;
      workspaceId: string;
      assignee: string;
      agentId: string | null;
      numbers: number[];
      started: boolean;
    },
  ) {
    // Caller holds the conversation row lock, shared with ordinary sends and mute changes.
    const latest = await tx.message.findFirst({
      where: { conversationId: input.conversationId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (latest?.sequence ?? 0) + 1;
    return tx.message.create({
      data: {
        id: input.id,
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        body: `${input.assignee} ${input.started ? "started" : "was assigned"} task${input.numbers.length === 1 ? "" : "s"} ${input.numbers.map((number) => `#${number}`).join(", ")}.`,
        sequence,
        deliveries: input.agentId
          ? {
              create: {
                workspaceId: input.workspaceId,
                conversationId: input.conversationId,
                agentId: input.agentId,
                sequence,
              },
            }
          : undefined,
      },
    });
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
        "system",
      ),
    ]);
  }

  private async findMessage(tx: Transaction, conversationId: string, messageId: string) {
    const messages =
      messageId.length === 8 && /^[0-9a-f]{8}$/i.test(messageId)
        ? await tx.$queryRaw<
            Array<{ id: string; body: string }>
          >`SELECT "id"::text, "body" FROM "messages" WHERE "conversationId" = ${conversationId}::uuid AND "threadRootId" IS NULL AND left("id"::text, 8) = lower(${messageId}) LIMIT 2`
        : await tx.message.findMany({
            where: { conversationId, threadRootId: null, id: messageId },
            take: 2,
            select: { id: true, body: true },
          });
    if (messages.length !== 1) throw new AppError(messages.length ? "CONFLICT" : "NOT_FOUND");
    return messages[0]!;
  }

  private async convertOrClaim(
    conversationId: string,
    workspaceId: string,
    memberId: string,
    command: TaskCommand,
    claim: boolean,
  ) {
    const task = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
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
            creatorMemberId: memberId,
          },
          select: taskSelection,
        });
      }
      if (!claim) return existing;
      if (
        existing.owner?.id === memberId &&
        (existing.status === "in_progress" || existing.status === "in_review")
      )
        return existing;
      if (existing.status === "done" || existing.status === "closed")
        throw new AppError("CONFLICT");
      if (existing.owner && existing.owner.id !== memberId) throw new AppError("CONFLICT");
      return this.commitTaskChange(
        tx,
        {
          messageId: existing.messageId,
          ownerMemberId: existing.owner?.id ?? null,
          status: existing.status,
          revision: existing.revision,
        },
        {
          ownerMemberId: memberId,
          claimedAt: new Date(),
          status: existing.status === "todo" ? "in_progress" : existing.status,
        },
      );
    });
    await this.signalTaskChange(task);
    return { tasks: [view(task)] };
  }

  private async claim(
    conversationId: string,
    workspaceId: string,
    memberId: string,
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
        conversationId,
        workspaceId,
        memberId,
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
          conversationId,
          workspaceId,
          memberId,
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

  private async unclaim(conversationId: string, memberId: string, command: TaskCommand) {
    const task = await this.db.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: {
        messageId: true,
        ownerMemberId: true,
        status: true,
        revision: true,
      },
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (task.ownerMemberId !== memberId) throw new AppError("ACCESS_DENIED");
    if (task.status === "done") throw new AppError("CONFLICT");
    const updated = await this.commitTaskChange(
      this.db,
      {
        messageId: task.messageId,
        revision: command.expectedRevision ?? task.revision,
        ownerMemberId: memberId,
        status: { not: "done" },
      },
      { ownerMemberId: null, claimedAt: null },
    );
    await this.signalTaskChange(updated);
    return { tasks: [view(updated)] };
  }

  private async update(conversationId: string, member: Member, command: TaskCommand) {
    const task = await this.db.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: { ...taskSelection, ownerMemberId: true },
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
    const updated = await this.commitTaskChange(
      this.db,
      { messageId: task.messageId, revision: task.revision, ownerMemberId: task.ownerMemberId },
      { status: command.status },
    );
    await this.signalTaskChange(updated);
    return { tasks: [view(updated)] };
  }

  private async assign(
    conversationId: string,
    workspaceId: string,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    if (command.assignee !== null && !command.assignee?.match(/^@[a-z0-9][a-z0-9_-]{0,63}$/))
      throw new AppError("INVALID_INPUT");
    const receiptId = await indexedRequestId(
      `${member.id}:assign:${command.number}:${command.requestId}:assignment`,
      1,
    );
    const result = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
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
        select: { messageId: true, revision: true, ownerMemberId: true },
      });
      if (!current) throw new AppError("NOT_FOUND");
      if (
        (owner && owner.id !== member.id) ||
        (current.ownerMemberId && current.ownerMemberId !== member.id)
      )
        await this.requireManager(tx, workspaceId, member);
      if (command.expectedRevision !== undefined && current.revision !== command.expectedRevision)
        throw new AppError("CONFLICT");
      if (current.ownerMemberId === (owner?.id ?? null)) {
        const task = await tx.task.findUniqueOrThrow({
          where: { messageId: current.messageId },
          select: taskSelection,
        });
        return { task, receipt: null, changed: false };
      }
      const task = await this.commitTaskChange(
        tx,
        {
          messageId: current.messageId,
          revision: current.revision,
          ownerMemberId: current.ownerMemberId,
        },
        { ownerMemberId: owner?.id ?? null, claimedAt: null },
      );
      return {
        task,
        changed: true,
        receipt: owner
          ? await this.writeAssignmentReceipt(tx, {
              id: receiptId,
              conversationId,
              workspaceId,
              assignee: command.assignee!,
              agentId: owner.agentId,
              numbers: [task.number],
              started: false,
            })
          : null,
      };
    });
    const { task, receipt } = result;
    if (task && result.changed) await this.signalTaskChange(task);
    if (receipt && result.changed)
      await this.publishAssignmentReceipt(receipt.id, command.requestId);
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
    conversationId: string,
    workspaceId: string,
    member: Member,
    command: TaskCommand,
  ): Promise<TaskResult> {
    const result = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      const current = await tx.task.findUnique({
        where: { conversationId_number: { conversationId, number: command.number! } },
        select: { messageId: true, revision: true, ownerMemberId: true },
      });
      if (!current) throw new AppError("NOT_FOUND");
      if (!current.ownerMemberId) {
        const task = await tx.task.findUniqueOrThrow({
          where: { messageId: current.messageId },
          select: taskSelection,
        });
        return { task, changed: false };
      }
      if (current.ownerMemberId !== member.id) await this.requireManager(tx, workspaceId, member);
      if (command.expectedRevision !== undefined && current.revision !== command.expectedRevision)
        throw new AppError("CONFLICT");
      const task = await this.commitTaskChange(
        tx,
        {
          messageId: current.messageId,
          revision: current.revision,
          ownerMemberId: current.ownerMemberId,
        },
        { ownerMemberId: null, claimedAt: null },
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
        select: {
          ...taskSelection,
          history: { orderBy: { sequence: "desc" }, take: 1 },
        },
      });
      if (!task) throw new AppError("NOT_FOUND");
      if (command.expectedRevision !== undefined && task.revision !== command.expectedRevision)
        throw new AppError("CONFLICT");
      const actor = await tx.conversationMember.findUniqueOrThrow({
        where: {
          id_conversationId_workspaceId: {
            id: member.id,
            conversationId,
            workspaceId: task.workspaceId,
          },
        },
        select: {
          agent: { select: { displayName: true } },
          user: { select: { displayName: true, username: true } },
        },
      });
      const updated = await this.commitTaskChange(
        tx,
        { messageId: task.messageId, revision: task.revision },
        {
          ...(command.title !== undefined && { title: command.title.trim() }),
          ...(command.description !== undefined && { description: command.description }),
        },
      );
      const event = await tx.taskHistoryEvent.create({
        data: {
          taskMessageId: task.messageId,
          sequence: (task.history[0]?.sequence ?? 0) + 1,
          eventType: "amended",
          actorKind: member.agentId ? "agent" : "user",
          actorName: actor.agent?.displayName ?? actor.user?.displayName ?? actor.user?.username,
          beforeTitle: command.title !== undefined ? task.title : undefined,
          afterTitle: command.title !== undefined ? updated.title : undefined,
          beforeDescription: command.description !== undefined ? task.description : undefined,
          afterDescription: command.description !== undefined ? updated.description : undefined,
        },
      });
      return { updated, event };
    });
    await this.signalTaskChange(result.updated);
    return { tasks: [view(result.updated)], history: [historyEventView(result.event)] };
  }

  private async history(conversationId: string, command: TaskCommand): Promise<TaskResult> {
    const task = await this.db.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: { ...taskSelection, history: { orderBy: { sequence: "asc" } } },
    });
    if (!task) throw new AppError("NOT_FOUND");
    return { tasks: [view(task)], history: task.history.map(historyEventView) };
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
          ownerMemberId: true,
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
      const updated = await this.commitTaskChange(
        tx,
        { messageId: task.messageId, revision: task.revision, resourceExpiryFollowupId: null },
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
            requestId: command.requestId,
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
    try {
      await this.dependencies.realtime?.messageAvailable({
        conversationId: task.conversationId,
        messageId: task.messageId,
        sequence: task.message.sequence,
        // Task metadata changes are always top-level messages, never thread replies.
        ...(await messageSignalScope(this.db, task.conversationId, task.workspaceId)),
        publicationId: `${task.messageId}:task:${task.revision}`,
      });
    } catch {
      // PostgreSQL is canonical; normal reconciliation repairs a missed metadata event.
    }
  }
}
