import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
  type TaskCommand,
  type TaskPrincipal,
  type TaskResult,
  type TaskStatus,
  type TaskView,
} from "@coforge/protocol";
import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import type { ConversationRealtime } from "../conversations/conversation-realtime.server";
import { mentionedNames } from "../conversations/mentions";
import { daemonControlChannel, type CentrifugoServerApi } from "../centrifugo/server-api.server";
import type { MessageNotifier } from "../notifications/web-push-composition.server";

type Dependencies = {
  realtime?: ConversationRealtime;
  notifications?: MessageNotifier;
  publisher?: Pick<CentrifugoServerApi, "publish">;
};

const taskSelection = {
  messageId: true,
  conversationId: true,
  number: true,
  title: true,
  status: true,
  revision: true,
  owner: {
    select: {
      id: true,
      user: { select: { username: true, displayName: true } },
      agent: { select: { name: true, displayName: true } },
    },
  },
} as const;

type SelectedTask = {
  messageId: string;
  conversationId: string;
  number: number;
  title: string;
  status: string;
  revision: number;
  owner: {
    id: string;
    user: { username: string; displayName: string | null } | null;
    agent: { name: string; displayName: string } | null;
  } | null;
};

export type TaskOverview = {
  tasks: Array<
    TaskView & {
      source: { channelName: string | null; agentId: string | null; label: string };
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

function view(task: SelectedTask): TaskView {
  return {
    messageId: task.messageId,
    conversationId: task.conversationId,
    number: task.number,
    title: task.title,
    status: status(task.status),
    revision: task.revision,
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
              members: { some: { userId } },
              AND: { members: { some: { agentId: { not: null } } } },
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
              where: { agentId: { not: null } },
              select: { agent: { select: { id: true, name: true, displayName: true } } },
            },
          },
        },
      },
    });

    return {
      tasks: tasks.map((task) => {
        const channelName = task.conversation.channelName;
        const agent = task.conversation.members[0]?.agent ?? null;
        if (channelName === null && agent === null) throw new AppError("INTERNAL_ERROR");
        return {
          ...view(task),
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
    const scope = await this.scope(principal, command);
    if (scope.channel && !scope.member && command.operation !== "list")
      throw new AppError("ACCESS_DENIED");
    if (!scope.member && !scope.channel) throw new AppError("ACCESS_DENIED");

    if (command.operation === "list") {
      const tasks = await this.db.task.findMany({
        where: { conversationId: scope.conversationId, status: command.status },
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
      return this.convertOrClaim(scope.conversationId, scope.workspaceId, member.id, command, true);
    if (command.operation === "unclaim")
      return this.unclaim(scope.conversationId, member.id, command);
    return this.update(scope.conversationId, member, command);
  }

  private validateCommand(command: TaskCommand) {
    const operations = ["list", "create", "convert", "claim", "unclaim", "update"];
    if (!operations.includes(command.operation) || !command.requestId)
      throw new AppError("INVALID_INPUT");
    if ((command.conversationId ? 1 : 0) + (command.target ? 1 : 0) !== 1)
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
      !["todo", "in_progress", "in_review", "done", "closed"].includes(command.status)
    )
      throw new AppError("INVALID_INPUT");
    if (command.number !== undefined && command.messageId !== undefined)
      throw new AppError("INVALID_INPUT");
    if (
      command.operation !== "update" &&
      command.operation !== "unclaim" &&
      command.expectedRevision !== undefined
    )
      throw new AppError("INVALID_INPUT");
    if (
      command.operation !== "update" &&
      command.operation !== "list" &&
      command.status !== undefined
    )
      throw new AppError("INVALID_INPUT");
    if (command.operation === "create") {
      const title = command.title?.trim();
      if (!title || title.length > 8_000) throw new AppError("INVALID_INPUT");
      if (command.number !== undefined || command.messageId !== undefined)
        throw new AppError("INVALID_INPUT");
    }
    if (
      ["unclaim", "update"].includes(command.operation) &&
      (!command.number || command.expectedRevision === undefined)
    )
      throw new AppError("INVALID_INPUT");
    if (command.operation === "update" && !command.status) throw new AppError("INVALID_INPUT");
    if (["convert", "claim"].includes(command.operation) && !command.number && !command.messageId)
      throw new AppError("INVALID_INPUT");
  }

  private async scope(principal: TaskPrincipal, command: TaskCommand) {
    if ((principal.userId ? 1 : 0) + (principal.agentId ? 1 : 0) !== 1)
      throw new AppError("ACCESS_DENIED");
    if (principal.userId) {
      if (command.target || !command.conversationId) throw new AppError("INVALID_INPUT");
      const workspaceMember = await this.db.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: principal.workspaceId, userId: principal.userId },
        },
      });
      if (!workspaceMember) throw new AppError("ACCESS_DENIED");
      const conversation = await this.db.conversation.findFirst({
        where: { id: command.conversationId, workspaceId: principal.workspaceId },
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
      where: { id: principal.agentId, workspaceId: principal.workspaceId },
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
            members: { some: { agentId: principal.agentId } },
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
            directKey: [principal.agentId!, targetUser!.id].sort().join(":"),
            AND: [
              { members: { some: { agentId: principal.agentId } } },
              { members: { some: { user: { username: target.slice(1) } } } },
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

  private async create(
    scope: {
      conversationId: string;
      workspaceId: string;
      channel: boolean;
      channelName: string | null;
    },
    member: { id: string; userId: string | null; agentId: string | null },
    principal: TaskPrincipal,
    command: TaskCommand,
  ) {
    const title = command.title!.trim();
    const result = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${scope.conversationId}::uuid FOR UPDATE`;
      const retried = await tx.task.findFirst({
        where: {
          conversationId: scope.conversationId,
          creatorMemberId: member.id,
          requestId: command.requestId,
        },
        select: taskSelection,
      });
      if (retried) return { task: retried, created: false, sequence: 0 };
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
      const lastTask = await tx.task.findFirst({
        where: { conversationId: scope.conversationId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const sequence = (lastMessage?.sequence ?? 0) + 1;
      const names = mentionedNames(title);
      const recipients = member.userId
        ? await tx.conversationMember.findMany({
            where: scope.channel
              ? {
                  conversationId: scope.conversationId,
                  agentId: { not: null },
                  OR: [{ channelMuted: false }, { agent: { name: { in: names } } }],
                }
              : { conversationId: scope.conversationId, agentId: { not: null } },
            select: { agentId: true },
          })
        : [];
      const message = await tx.message.create({
        data: {
          conversationId: scope.conversationId,
          workspaceId: scope.workspaceId,
          senderMemberId: member.id,
          body: title,
          sequence,
          attachment: command.attachmentId ? { connect: { id: command.attachmentId } } : undefined,
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
              number: (lastTask?.number ?? 0) + 1,
              title,
              creatorMemberId: member.id,
              requestId: command.requestId,
            },
          },
        },
        select: { id: true, sequence: true, task: { select: taskSelection } },
      });
      return { task: message.task!, created: true, sequence };
    });
    if (result.created) {
      if (member.userId) {
        try {
          await this.dependencies.notifications?.notifyMessage(result.task.messageId);
        } catch {
          // PostgreSQL is canonical; notification recovery handles missed delivery.
        }
      }
      try {
        await this.dependencies.realtime?.messageAvailable({
          conversationId: scope.conversationId,
          messageId: result.task.messageId,
          sequence: result.sequence,
        });
      } catch {
        // PostgreSQL is canonical; normal history reconciliation repairs a missed event.
      }
      if (member.userId && this.dependencies.publisher) {
        const message = await this.db.message.findUniqueOrThrow({
          where: { id: result.task.messageId },
          include: {
            sender: { include: { user: true } },
            deliveries: { include: { agent: true } },
          },
        });
        for (const delivery of message.deliveries) {
          if (!delivery.agent.computerId) continue;
          try {
            await this.dependencies.publisher.publish(
              daemonControlChannel(scope.workspaceId, delivery.agent.computerId),
              encodeAgentMessageDelivery({
                protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
                method: AGENT_MESSAGE_METHOD,
                requestId: command.requestId,
                workspaceId: scope.workspaceId,
                conversationId: scope.conversationId,
                agentId: delivery.agentId,
                messageId: message.id,
                deliveryId: delivery.deliveryId,
                sequence: message.sequence,
                body: message.body,
                target: scope.channelName
                  ? `#${scope.channelName}`
                  : `@${message.sender.user!.username}`,
                latestSender: `@${message.sender.user!.username}`,
              }),
            );
          } catch {
            // PostgreSQL delivery state supports recovery; do not report a committed Task as failed.
          }
        }
      }
    }
    return { tasks: [view(result.task)] };
  }

  private async findMessage(
    tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
    conversationId: string,
    messageId: string,
  ) {
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
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
      let existing = command.number
        ? await tx.task.findUnique({
            where: { conversationId_number: { conversationId, number: command.number } },
            select: taskSelection,
          })
        : undefined;
      let message: { id: string; body: string } | undefined;
      if (!existing && command.messageId) {
        message = await this.findMessage(tx, conversationId, command.messageId);
        existing =
          (await tx.task.findUnique({ where: { messageId: message.id }, select: taskSelection })) ??
          undefined;
      }
      if (!existing) {
        if (!message) throw new AppError("NOT_FOUND");
        const last = await tx.task.findFirst({
          where: { conversationId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        existing = await tx.task.create({
          data: {
            messageId: message.id,
            conversationId,
            workspaceId,
            number: (last?.number ?? 0) + 1,
            title: message.body.slice(0, 8_000),
            creatorMemberId: memberId,
          },
          select: taskSelection,
        });
      }
      if (!claim) return existing;
      if (existing.owner?.id === memberId && existing.status === "in_progress") return existing;
      if (existing.status !== "todo") throw new AppError("CONFLICT");
      if (existing.owner) throw new AppError("CONFLICT");
      const updated = await tx.task.updateMany({
        where: {
          messageId: existing.messageId,
          ownerMemberId: null,
          status: "todo",
          revision: existing.revision,
        },
        data: { ownerMemberId: memberId, status: "in_progress", revision: { increment: 1 } },
      });
      if (updated.count !== 1) throw new AppError("CONFLICT");
      return tx.task.findUniqueOrThrow({
        where: { messageId: existing.messageId },
        select: taskSelection,
      });
    });
    await this.signalTaskChange(task);
    return { tasks: [view(task)] };
  }

  private async unclaim(conversationId: string, memberId: string, command: TaskCommand) {
    const task = await this.db.task.findUnique({
      where: { conversationId_number: { conversationId, number: command.number! } },
      select: { messageId: true, ownerMemberId: true, status: true },
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (task.ownerMemberId !== memberId) throw new AppError("ACCESS_DENIED");
    if (task.status === "done" || task.status === "closed") throw new AppError("CONFLICT");
    const changed = await this.db.task.updateMany({
      where: {
        messageId: task.messageId,
        ownerMemberId: memberId,
        status: { notIn: ["done", "closed"] },
        revision: command.expectedRevision,
      },
      data: { ownerMemberId: null, status: "todo", revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new AppError("CONFLICT");
    const updated = await this.db.task.findUniqueOrThrow({
      where: { conversationId_number: { conversationId, number: command.number! } },
      select: taskSelection,
    });
    await this.signalTaskChange(updated);
    return { tasks: [view(updated)] };
  }

  private async update(
    conversationId: string,
    member: { id: string; userId: string | null; agentId: string | null },
    command: TaskCommand,
  ) {
    const task = await this.db.task.findUnique({
      where: { conversationId_number: { conversationId, number: command.number! } },
      select: { ...taskSelection, ownerMemberId: true },
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (task.revision !== command.expectedRevision) throw new AppError("CONFLICT");
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
    const changed = await this.db.task.updateMany({
      where: { messageId: task.messageId, revision: command.expectedRevision },
      data: {
        status: command.status,
        ownerMemberId: command.status === "todo" ? null : undefined,
        revision: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new AppError("CONFLICT");
    const updated = await this.db.task.findUniqueOrThrow({
      where: { messageId: task.messageId },
      select: taskSelection,
    });
    await this.signalTaskChange(updated);
    return { tasks: [view(updated)] };
  }

  private async signalTaskChange(task: SelectedTask) {
    try {
      const message = await this.db.message.findUniqueOrThrow({
        where: { id: task.messageId },
        select: { sequence: true },
      });
      await this.dependencies.realtime?.messageAvailable({
        conversationId: task.conversationId,
        messageId: task.messageId,
        sequence: message.sequence,
        publicationId: `${task.messageId}:task:${task.revision}`,
      });
    } catch {
      // PostgreSQL is canonical; normal reconciliation repairs a missed metadata event.
    }
  }
}
