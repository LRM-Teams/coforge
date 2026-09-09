import {
  decodeAgentReminderOperationResponse,
  decodeReminderFireResponse,
  encodeAgentReminderOperationResponse,
  encodeReminderFireResponse,
  type ReminderFireRequest,
  type ReminderFireResponse,
} from "@coforge/protocol";
import { Prisma, type PrismaClient } from "../../../../generated/client";
import {
  MAX_ACTIVE_REMINDERS,
  nextOccurrence,
  type ReminderRepository,
  type StoredReminder,
} from "../../reminders/reminders.server";

type Scope = { workspaceId: string; computerId: string; agentId: string; userId: string };
type ReminderRow = Prisma.ReminderGetPayload<Record<string, never>>;

const summary = (row: ReminderRow): StoredReminder => ({
  reminderId: row.id,
  ownerAgentId: row.ownerAgentId,
  computerId: row.computerId,
  version: row.version,
  title: row.title,
  target: row.target,
  messageId: row.messageId,
  fireAt: row.fireAt.toISOString(),
  status: row.status as StoredReminder["status"],
  ...(row.repeat ? { repeat: row.repeat } : {}),
  ...(row.timezone ? { timezone: row.timezone } : {}),
  createdAt: row.createdAt.toISOString(),
  ...(row.firedAt ? { firedAt: row.firedAt.toISOString() } : {}),
});

function encodeStored(scope: Scope, requestId: string, value: StoredReminder) {
  return encodeAgentReminderOperationResponse({
    protocolMajor: 1,
    requestId,
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    agentId: scope.agentId,
    accepted: true,
    reminders: [value],
    events: [],
  });
}

function decodeStored(scope: Scope, bytes: Uint8Array) {
  const value = decodeAgentReminderOperationResponse(bytes).reminders[0];
  if (!value) throw new Error("invalid reminder operation receipt");
  return { ...value, computerId: scope.computerId };
}

export class PrismaReminderRepository implements ReminderRepository {
  constructor(private readonly db: PrismaClient) {}

  async authorize(scope: Scope) {
    return Boolean(
      await this.db.agent.findFirst({
        where: {
          id: scope.agentId,
          workspaceId: scope.workspaceId,
          ownerId: scope.userId,
          computerId: scope.computerId,
          workspace: { members: { some: { userId: scope.userId } } },
          computer: { workspaces: { some: { workspaceId: scope.workspaceId } } },
        },
        select: { id: true },
      }),
    );
  }

  async authorizeDaemon(scope: Omit<Scope, "userId">) {
    const agent = await this.db.agent.findFirst({
      where: {
        id: scope.agentId,
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        owner: { memberships: { some: { workspaceId: scope.workspaceId } } },
        computer: { workspaces: { some: { workspaceId: scope.workspaceId } } },
      },
      select: { ownerId: true },
    });
    return agent ? { userId: agent.ownerId } : undefined;
  }

  async replay(scope: Scope, requestId: string, fingerprint: string, reminderId?: string) {
    const receipt = await this.db.reminderOperationReceipt.findUnique({
      where: { agentId_requestId: { agentId: scope.agentId, requestId } },
    });
    if (!receipt) return undefined;
    if (
      receipt.workspaceId !== scope.workspaceId ||
      receipt.fingerprint !== fingerprint ||
      (reminderId !== undefined && receipt.reminderId !== reminderId)
    )
      throw new Error("request ID was already used with different reminder input");
    return decodeStored(scope, receipt.response);
  }

  async resolveAnchor(scope: Scope, target: string, messageId: string) {
    const [base, threadPrefix] = target.split(":");
    const conversation = base!.startsWith("#")
      ? await this.db.conversation.findFirst({
          where: {
            workspaceId: scope.workspaceId,
            channelName: base!.slice(1),
            members: { some: { agentId: scope.agentId } },
          },
          select: { id: true },
        })
      : await this.db.conversation.findFirst({
          where: {
            workspaceId: scope.workspaceId,
            channelName: null,
            AND: [
              { members: { some: { agentId: scope.agentId } } },
              { members: { some: { user: { username: base!.slice(1) } } } },
            ],
          },
          select: { id: true },
        });
    if (!conversation) throw new Error("reminder target is not authorized");
    let rootId: string | undefined;
    if (threadPrefix) {
      const roots = await this.db.message.findMany({
        where: {
          conversationId: conversation.id,
          threadRootId: null,
          id:
            threadPrefix.length === 8
              ? { startsWith: threadPrefix, mode: "insensitive" }
              : threadPrefix,
        },
        select: { id: true },
        take: 2,
      });
      if (roots.length !== 1) throw new Error("thread target is missing or ambiguous");
      rootId = roots[0]!.id;
    }
    const candidates = await this.db.message.findMany({
      where: {
        conversationId: conversation.id,
        id: messageId.length === 8 ? { startsWith: messageId, mode: "insensitive" } : messageId,
        ...(rootId ? { OR: [{ id: rootId }, { threadRootId: rootId }] } : { threadRootId: null }),
      },
      select: { id: true },
      take: 2,
    });
    if (candidates.length !== 1) throw new Error("message anchor is missing or ambiguous");
    return { messageId: candidates[0]!.id, target: rootId ? `${base}:${rootId}` : base! };
  }

  async create(
    scope: Scope,
    requestId: string,
    fingerprint: string,
    input: Omit<StoredReminder, "reminderId" | "createdAt">,
  ) {
    return this.db.$transaction(
      async (tx) => {
        const authorized = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT "id" FROM "agents" WHERE "id" = ${scope.agentId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid AND "ownerId" = ${scope.userId}::uuid AND "computerId" = ${scope.computerId}::uuid FOR UPDATE`;
        if (authorized.length !== 1) throw new Error("reminder operation is not authorized");
        if (!(await this.transactionScopeExists(tx, scope)))
          throw new Error("reminder operation is not authorized");
        const replay = await tx.reminderOperationReceipt.findUnique({
          where: { agentId_requestId: { agentId: scope.agentId, requestId } },
        });
        if (replay) {
          if (replay.workspaceId !== scope.workspaceId || replay.fingerprint !== fingerprint)
            throw new Error("request ID was already used with different reminder input");
          return decodeStored(scope, replay.response);
        }
        const active = await tx.reminder.count({
          where: {
            workspaceId: scope.workspaceId,
            ownerAgentId: scope.agentId,
            status: "scheduled",
          },
        });
        if (active >= MAX_ACTIVE_REMINDERS)
          throw new Error(`active reminder limit (${MAX_ACTIVE_REMINDERS}) reached`);
        const row = await tx.reminder.create({
          data: {
            workspaceId: scope.workspaceId,
            ownerAgentId: scope.agentId,
            computerId: scope.computerId,
            title: input.title,
            target: input.target,
            messageId: input.messageId,
            fireAt: new Date(input.fireAt),
            repeat: input.repeat,
            timezone: input.timezone,
            status: "scheduled",
            version: 1,
            events: {
              create: {
                workspace: { connect: { id: scope.workspaceId } },
                type: "created",
                title: input.title,
                scheduledFor: new Date(input.fireAt),
              },
            },
          },
        });
        const result = summary(row);
        await tx.reminderOperationReceipt.create({
          data: {
            workspaceId: scope.workspaceId,
            agentId: scope.agentId,
            requestId,
            fingerprint,
            response: new Uint8Array(encodeStored(scope, requestId, result)),
            reminderId: row.id,
          },
        });
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async list(scope: Scope, status?: string, all = false) {
    const rows = await this.db.reminder.findMany({
      where: {
        workspaceId: scope.workspaceId,
        ownerAgentId: scope.agentId,
        ...(!all
          ? status
            ? { status }
            : { status: { in: ["scheduled", "fired"] } }
          : status
            ? { status }
            : {}),
      },
      orderBy: { fireAt: "asc" },
      take: 101,
    });
    if (rows.length > 100) throw new Error("too many reminder results; use a status filter");
    return rows.map(summary);
  }

  async get(scope: Scope, id: string) {
    const row = await this.db.reminder.findFirst({
      where: {
        id,
        workspaceId: scope.workspaceId,
        ownerAgentId: scope.agentId,
        computerId: scope.computerId,
      },
    });
    return row ? summary(row) : undefined;
  }

  async update(
    scope: Scope,
    requestId: string,
    fingerprint: string,
    id: string,
    request: import("@coforge/protocol").AgentReminderOperationRequest,
    now: Date,
    eventType: "updated" | "snoozed" | "canceled",
  ) {
    return this.db.$transaction(
      async (tx) => {
        const authorized = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT "id" FROM "agents" WHERE "id" = ${scope.agentId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid AND "ownerId" = ${scope.userId}::uuid AND "computerId" = ${scope.computerId}::uuid FOR UPDATE`;
        if (authorized.length !== 1) throw new Error("reminder operation is not authorized");
        if (!(await this.transactionScopeExists(tx, scope)))
          throw new Error("reminder operation is not authorized");
        await tx.$queryRaw`SELECT "id" FROM "reminders" WHERE "id" = ${id}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid AND "ownerAgentId" = ${scope.agentId}::uuid AND "computerId" = ${scope.computerId}::uuid FOR UPDATE`;
        const replay = await tx.reminderOperationReceipt.findUnique({
          where: { agentId_requestId: { agentId: scope.agentId, requestId } },
        });
        if (replay) {
          if (
            replay.workspaceId !== scope.workspaceId ||
            replay.reminderId !== id ||
            replay.fingerprint !== fingerprint
          )
            throw new Error("request ID was already used with different reminder input");
          return decodeStored(scope, replay.response);
        }
        const existing = await tx.reminder.findFirst({
          where: {
            id,
            workspaceId: scope.workspaceId,
            ownerAgentId: scope.agentId,
            computerId: scope.computerId,
          },
        });
        if (!existing) throw new Error("reminder not found");
        if (eventType === "updated" && existing.status !== "scheduled")
          throw new Error("only scheduled reminders can be updated");
        if (eventType === "snoozed" && existing.status === "canceled")
          throw new Error("canceled reminders cannot be snoozed");
        if (request.timezone && request.repeat === "none")
          throw new Error("repeat none cannot include timezone");
        if (request.timezone && !request.repeat && !existing.repeat)
          throw new Error("timezone requires a recurring reminder");
        if (eventType === "snoozed" && existing.status !== "scheduled") {
          const active = await tx.reminder.count({
            where: {
              workspaceId: scope.workspaceId,
              ownerAgentId: scope.agentId,
              status: "scheduled",
            },
          });
          if (active >= MAX_ACTIVE_REMINDERS)
            throw new Error(`active reminder limit (${MAX_ACTIVE_REMINDERS}) reached`);
        }
        const zone =
          request.repeat && request.repeat !== "none"
            ? (request.timezone ?? existing.timezone ?? "Asia/Shanghai")
            : request.timezone;
        const patch: Partial<
          Pick<StoredReminder, "title" | "fireAt" | "repeat" | "timezone" | "status">
        > = {};
        if (eventType === "canceled") patch.status = "canceled";
        if (request.title) patch.title = request.title;
        if (request.operation === "snooze") {
          patch.fireAt =
            request.fireAt ?? new Date(now.getTime() + request.delaySeconds! * 1000).toISOString();
          patch.status = "scheduled";
        } else if (request.fireAt) patch.fireAt = request.fireAt;
        if (request.repeat === "none") {
          patch.repeat = undefined;
          patch.timezone = undefined;
        } else if (request.repeat) {
          patch.repeat = request.repeat;
          patch.timezone = zone;
        } else if (request.timezone) {
          patch.timezone = request.timezone;
        }
        if (
          request.operation === "update" &&
          !request.fireAt &&
          (request.delaySeconds ||
            request.timezone ||
            (request.repeat && request.repeat !== "none"))
        )
          patch.fireAt = request.delaySeconds
            ? new Date(now.getTime() + request.delaySeconds * 1000).toISOString()
            : nextOccurrence(
                patch.repeat ?? existing.repeat!,
                patch.timezone ?? existing.timezone!,
                existing.fireAt,
                now,
              ).toISOString();
        if (patch.fireAt && new Date(patch.fireAt).getTime() <= now.getTime())
          throw new Error("reminder time must be in the future");
        const cancelNoop = eventType === "canceled" && existing.status === "canceled";
        const row = cancelNoop
          ? existing
          : await tx.reminder.update({
              where: { id },
              data: {
                version: { increment: 1 },
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(patch.fireAt !== undefined ? { fireAt: new Date(patch.fireAt) } : {}),
                ...(patch.status !== undefined ? { status: patch.status } : {}),
                ...(eventType === "snoozed" ? { firedAt: null } : {}),
                ...(Object.hasOwn(patch, "repeat") ? { repeat: patch.repeat ?? null } : {}),
                ...(Object.hasOwn(patch, "timezone") ? { timezone: patch.timezone ?? null } : {}),
                events: {
                  create: {
                    workspace: { connect: { id: scope.workspaceId } },
                    type: eventType,
                    title: patch.title ?? existing.title,
                    scheduledFor: new Date(patch.fireAt ?? existing.fireAt),
                  },
                },
              },
            });
        const result = summary(row);
        await tx.reminderOperationReceipt.create({
          data: {
            workspaceId: scope.workspaceId,
            agentId: scope.agentId,
            requestId,
            fingerprint,
            response: new Uint8Array(encodeStored(scope, requestId, result)),
            reminderId: id,
          },
        });
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async events(scope: Scope, id: string, limit: number) {
    if (!(await this.get(scope, id))) throw new Error("reminder not found");
    return (
      await this.db.reminderEvent.findMany({
        where: { reminderId: id, workspaceId: scope.workspaceId },
        orderBy: { time: "desc" },
        take: limit,
      })
    ).map((event) => ({
      eventId: event.id,
      type: event.type,
      time: event.time.toISOString(),
      ...(event.nextFireAt ? { nextFireAt: event.nextFireAt.toISOString() } : {}),
    }));
  }

  async fire(scope: Scope, request: ReminderFireRequest, now: Date) {
    return this.db.$transaction(
      async (tx) => {
        const authorized = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT "id" FROM "agents" WHERE "id" = ${scope.agentId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid AND "ownerId" = ${scope.userId}::uuid AND "computerId" = ${scope.computerId}::uuid FOR UPDATE`;
        if (authorized.length !== 1) throw new Error("reminder fire is not authorized");
        if (!(await this.transactionScopeExists(tx, scope)))
          throw new Error("reminder fire is not authorized");
        await tx.$queryRaw`SELECT "id" FROM "reminders" WHERE "id" = ${request.reminderId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid AND "ownerAgentId" = ${scope.agentId}::uuid AND "computerId" = ${scope.computerId}::uuid FOR UPDATE`;
        const reminder = await tx.reminder.findFirst({
          where: {
            id: request.reminderId,
            workspaceId: scope.workspaceId,
            ownerAgentId: scope.agentId,
            computerId: scope.computerId,
          },
        });
        if (!reminder) return { result: this.obsolete(request) };
        const replay = await tx.reminderFireReceipt.findUnique({
          where: {
            reminderId_requestId: { reminderId: request.reminderId, requestId: request.requestId },
          },
        });
        if (replay) {
          if (
            replay.workspaceId !== scope.workspaceId ||
            replay.computerId !== scope.computerId ||
            replay.agentId !== scope.agentId ||
            replay.version !== request.version
          )
            throw new Error("request ID was already used with different reminder fire input");
          const result = decodeReminderFireResponse(replay.response);
          const current =
            result.result === "accepted" && reminder.status === "scheduled"
              ? summary(reminder)
              : undefined;
          return { result, ...(current ? { nextReminder: current } : {}) };
        }
        if (reminder.status !== "scheduled" || reminder.version !== request.version)
          return { result: this.obsolete(request) };
        if (reminder.fireAt.getTime() > now.getTime())
          return {
            result: {
              ...request,
              result: "premature" as const,
              fired: false,
              catchup: false,
              retryAfterMs: Math.max(1, reminder.fireAt.getTime() - now.getTime()),
              reason: "server clock says reminder is not due",
            },
          };
        const next = reminder.repeat
          ? nextOccurrence(reminder.repeat, reminder.timezone!, reminder.fireAt, now)
          : undefined;
        const changed = await tx.reminder.update({
          where: { id: reminder.id },
          data: next
            ? { fireAt: next, version: { increment: 1 }, firedAt: now }
            : { status: "fired", firedAt: now, version: { increment: 1 } },
        });
        await tx.reminderEvent.create({
          data: {
            reminderId: reminder.id,
            workspaceId: reminder.workspaceId,
            type: "fired",
            title: reminder.title,
            time: now,
            scheduledFor: reminder.fireAt,
            nextFireAt: next,
          },
        });
        const result: ReminderFireResponse = {
          ...request,
          result: "accepted",
          fired: true,
          catchup: now.getTime() > reminder.fireAt.getTime(),
        };
        await tx.reminderFireReceipt.create({
          data: {
            reminderId: request.reminderId,
            requestId: request.requestId,
            workspaceId: scope.workspaceId,
            computerId: scope.computerId,
            agentId: scope.agentId,
            version: request.version,
            response: new Uint8Array(encodeReminderFireResponse(result)),
          },
        });
        return { result, ...(next ? { nextReminder: summary(changed) } : {}) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async transactionScopeExists(tx: Prisma.TransactionClient, scope: Scope) {
    const [membership, connection] = await Promise.all([
      tx.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: scope.userId } },
        select: { userId: true },
      }),
      tx.workspaceComputer.findUnique({
        where: {
          workspaceId_computerId: { workspaceId: scope.workspaceId, computerId: scope.computerId },
        },
        select: { id: true },
      }),
    ]);
    return Boolean(membership && connection);
  }

  private obsolete(request: ReminderFireRequest): ReminderFireResponse {
    return {
      ...request,
      result: "obsolete",
      fired: false,
      catchup: false,
      reason: "reminder is stale or canceled",
    };
  }
}
