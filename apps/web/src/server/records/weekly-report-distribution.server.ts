import { recipientUserIdsForSend } from "./weekly-report-send-recipients.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  currentIsoWeek,
  memberReportTitle,
  memberWeekTitle,
  normalizeReportContent,
  withAssignmentUnread,
  withoutWeekSendDismissed,
  isAutoSendCancelled,
} from "#src/features/records/records-content";
import {
  parseTemplateSections,
  reportContentFromSections,
} from "#src/features/records/template-outline-sections";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";

export type WeeklyReportAssignmentNotice = {
  workspaceId: string;
  userId: string;
  reportId: string;
  templateName: string;
  year: number;
  week: number;
};
export type WeeklyReportNoticeResult = { status: "notified" | "assistant_unconfigured" | "failed" };
export type WeeklyReportNotifier = {
  notify(input: WeeklyReportAssignmentNotice): Promise<WeeklyReportNoticeResult>;
};

/** One settings stream has one distribution per ISO week, across all entry points. */
export async function distributeWeeklyReport(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; templateId: string; content?: unknown; now?: Date },
  notifier?: WeeklyReportNotifier,
) {
  const { year, week } = currentIsoWeek(zonedCalendarDate(input.now ?? new Date()));
  const distribution = await db.$transaction(async (tx) => {
    // Serialize manual sends, cron and retries on the existing settings row.
    await tx.$queryRaw`SELECT id FROM weekly_report_templates WHERE id = ${input.templateId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid FOR UPDATE`;
    const settings = await tx.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      include: { recipients: { select: { userId: true } } },
    });
    if (!settings) throw new AppError("NOT_FOUND");
    const memberships = await tx.workspaceMembership.findMany({
      where: { workspaceId: input.workspaceId },
      select: { userId: true },
    });
    const memberIds = new Set(memberships.map((member) => member.userId));
    if (!memberIds.has(input.userId)) throw new AppError("ACCESS_DENIED");
    const liveFormat = await tx.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        settingsId: settings.id,
        kind: "template",
        submissions: { none: { kind: "member" } },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, content: true },
    });
    if (liveFormat && isAutoSendCancelled(normalizeReportContent(liveFormat.content), year, week)) {
      await tx.weeklyReport.update({
        where: { id: liveFormat.id },
        data: {
          content: withoutWeekSendDismissed(
            normalizeReportContent(liveFormat.content),
            year,
            week,
          ) as Prisma.InputJsonValue,
        },
      });
    }
    const existing = await tx.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        settingsId: settings.id,
        kind: "template",
        cycle: { year, week },
        submissions: { some: { kind: "member" } },
      },
      select: { id: true, title: true, submissions: { select: { id: true, authorId: true } } },
    });
    if (existing)
      return {
        parentId: existing.id,
        title: existing.title,
        assignments: existing.submissions,
        templateName: settings.name,
        alreadySent: true,
      };
    const recipientIds = recipientUserIdsForSend({
      allMembers: settings.allMembers,
      recipientUserIds: settings.recipients.map((row) => row.userId),
      workspaceMemberIds: [...memberIds],
      senderUserId: input.userId,
    }).filter((id) => memberIds.has(id));
    if (!recipientIds.length) throw new AppError("INVALID_INPUT");
    const recipients = await tx.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, username: true, displayName: true },
    });
    const cycle = await tx.weeklyReportCycle.upsert({
      where: { workspaceId_year_week: { workspaceId: input.workspaceId, year, week } },
      create: {
        workspaceId: input.workspaceId,
        year,
        week,
        title: memberWeekTitle(year, week),
        createdById: input.userId,
      },
      update: {},
    });
    const content = withoutWeekSendDismissed(
      input.content !== undefined
        ? normalizeReportContent(input.content)
        : liveFormat
          ? normalizeReportContent(liveFormat.content)
          : reportContentFromSections(parseTemplateSections(settings.dimensions)),
      year,
      week,
    );
    const parent = await tx.weeklyReport.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        authorId: input.userId,
        settingsId: settings.id,
        kind: "template",
        title: memberWeekTitle(year, week),
        content: content as Prisma.InputJsonValue,
      },
      select: { id: true, title: true },
    });
    const assignments = await tx.weeklyReport.createManyAndReturn({
      data: recipients.map((member) => ({
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        authorId: member.id,
        sourceTemplateId: parent.id,
        kind: "member",
        title: memberReportTitle(member.displayName ?? member.username, year, week),
        status: "draft",
        content: withAssignmentUnread(content, true) as Prisma.InputJsonValue,
      })),
      select: { id: true, authorId: true },
    });
    return {
      parentId: parent.id,
      title: parent.title,
      assignments,
      templateName: settings.name,
      alreadySent: false,
    };
  });
  const notifications = await notifyWeeklyReportAssignments(
    db,
    {
      workspaceId: input.workspaceId,
      templateName: distribution.templateName,
      year,
      week,
      assignments: distribution.assignments,
    },
    notifier,
  );
  return {
    parentId: distribution.parentId,
    title: distribution.title,
    year,
    week,
    assignmentCount: distribution.assignments.length,
    alreadySent: distribution.alreadySent,
    notifications,
  };
}

/** Retry invitations independently of creating the already committed weekly collection. */
export async function retryWeeklyReportInvitations(
  db: PrismaClient,
  input: {
    workspaceId: string;
    parentId: string;
    templateName: string;
    year: number;
    week: number;
  },
  notifier?: WeeklyReportNotifier,
) {
  const assignments = await db.weeklyReport.findMany({
    where: {
      workspaceId: input.workspaceId,
      sourceTemplateId: input.parentId,
      kind: "member",
      author: { memberships: { some: { workspaceId: input.workspaceId } } },
    },
    select: { id: true, authorId: true },
  });
  return notifyWeeklyReportAssignments(db, { ...input, assignments }, notifier);
}

async function notifyWeeklyReportAssignments(
  db: PrismaClient,
  input: {
    workspaceId: string;
    templateName: string;
    year: number;
    week: number;
    assignments: Array<{ id: string; authorId: string }>;
  },
  notifier?: WeeklyReportNotifier,
) {
  const notify =
    notifier ?? (await import("./weekly-report-notification.server")).weeklyReportNotifier(db);
  const notifications: Array<{ reportId: string; status: WeeklyReportNoticeResult["status"] }> = [];
  for (let offset = 0; offset < input.assignments.length; offset += 4) {
    const batch = await Promise.all(
      input.assignments.slice(offset, offset + 4).map(async (assignment) => {
        try {
          const result = await notify.notify({
            workspaceId: input.workspaceId,
            userId: assignment.authorId,
            reportId: assignment.id,
            templateName: input.templateName,
            year: input.year,
            week: input.week,
          });
          return { reportId: assignment.id, status: result.status };
        } catch {
          return { reportId: assignment.id, status: "failed" as const };
        }
      }),
    );
    notifications.push(...batch);
  }
  return notifications;
}
