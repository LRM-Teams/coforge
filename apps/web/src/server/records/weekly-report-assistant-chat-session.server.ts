import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

export type WeeklyReportAssistantChatSessionRecord = {
  id: string;
  subjectType: "report" | "cycle";
  subjectId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

function requireMembership(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<unknown> {
  return db.workspaceMembership.findUniqueOrThrow({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

function toRecord(row: {
  id: string;
  subjectType: string;
  subjectId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): WeeklyReportAssistantChatSessionRecord {
  return {
    id: row.id,
    subjectType: row.subjectType as "report" | "cycle",
    subjectId: row.subjectId,
    title: row.title,
    status: row.status === "archived" ? "archived" : "active",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Lists side-chat sessions for one page subject. */
export async function listWeeklyReportAssistantChatSessions(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
  },
): Promise<WeeklyReportAssistantChatSessionRecord[]> {
  await requireMembership(db, input.workspaceId, input.userId);
  const rows = await db.weeklyReportAssistantChatSession.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: "active",
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toRecord);
}

/**
 * Creates a new empty side-chat session.
 * Title starts untitled; first user turn may rename it.
 */
export async function createWeeklyReportAssistantChatSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    title?: string;
  },
): Promise<WeeklyReportAssistantChatSessionRecord> {
  await requireMembership(db, input.workspaceId, input.userId);
  const row = await db.weeklyReportAssistantChatSession.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: (input.title ?? "").trim().slice(0, 80),
      status: "active",
    },
  });
  return toRecord(row);
}

/**
 * Ensures at least one session exists for the page. Backfills a session when
 * legacy comments (no session id) already exist so history stays reachable.
 */
export async function ensureWeeklyReportAssistantChatSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
  },
): Promise<{
  sessions: WeeklyReportAssistantChatSessionRecord[];
  activeSessionId: string;
  legacySessionId: string | null;
}> {
  await requireMembership(db, input.workspaceId, input.userId);
  let sessions = await listWeeklyReportAssistantChatSessions(db, input);
  if (sessions.length === 0) {
    const where =
      input.subjectType === "report" ? { reportId: input.subjectId } : { cycleId: input.subjectId };
    const legacyCount = await db.recordComment.count({
      where: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        assistantSessionId: null,
        ...where,
      },
    });
    const created = await createWeeklyReportAssistantChatSession(db, {
      ...input,
      title: legacyCount > 0 ? "" : "",
    });
    if (legacyCount > 0) {
      await db.recordComment.updateMany({
        where: {
          workspaceId: input.workspaceId,
          subjectType: input.subjectType,
          assistantSessionId: null,
          ...where,
        },
        data: { assistantSessionId: created.id },
      });
    }
    sessions = [created];
  }
  const oldest = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return {
    sessions,
    activeSessionId: sessions[0]!.id,
    legacySessionId: oldest?.id ?? null,
  };
}

export async function touchWeeklyReportAssistantChatSession(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; sessionId: string; title?: string },
) {
  const existing = await db.weeklyReportAssistantChatSession.findFirst({
    where: {
      id: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
  });
  if (!existing) throw new AppError("NOT_FOUND");
  const nextTitle =
    input.title !== undefined && !existing.title.trim()
      ? input.title.trim().slice(0, 80)
      : undefined;
  await db.weeklyReportAssistantChatSession.update({
    where: { id: existing.id },
    data: {
      updatedAt: new Date(),
      ...(nextTitle ? { title: nextTitle } : {}),
    },
  });
}

/** Explicit rename: always overwrites the session title. */
export async function renameWeeklyReportAssistantChatSession(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; sessionId: string; title: string },
): Promise<WeeklyReportAssistantChatSessionRecord> {
  await requireMembership(db, input.workspaceId, input.userId);
  const existing = await db.weeklyReportAssistantChatSession.findFirst({
    where: {
      id: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: "active",
    },
  });
  if (!existing) throw new AppError("NOT_FOUND");
  const title = input.title.trim().slice(0, 80);
  const row = await db.weeklyReportAssistantChatSession.update({
    where: { id: existing.id },
    data: { title, updatedAt: new Date() },
  });
  return toRecord(row);
}

/** Soft-delete: archive so the history picker no longer lists it. */
export async function archiveWeeklyReportAssistantChatSession(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; sessionId: string },
): Promise<{ ok: true }> {
  await requireMembership(db, input.workspaceId, input.userId);
  const existing = await db.weeklyReportAssistantChatSession.findFirst({
    where: {
      id: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: "active",
    },
  });
  if (!existing) throw new AppError("NOT_FOUND");
  await db.weeklyReportAssistantChatSession.update({
    where: { id: existing.id },
    data: { status: "archived", updatedAt: new Date() },
  });
  return { ok: true as const };
}

export async function requireOwnedChatSession(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; sessionId: string },
) {
  const row = await db.weeklyReportAssistantChatSession.findFirst({
    where: {
      id: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
  });
  if (!row) throw new AppError("NOT_FOUND");
  return toRecord(row);
}

/** Latest session for a subject, or create one when posting platform cards. */
export async function resolveLatestChatSessionId(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
  },
): Promise<string> {
  const ensured = await ensureWeeklyReportAssistantChatSession(db, input);
  return ensured.activeSessionId;
}
