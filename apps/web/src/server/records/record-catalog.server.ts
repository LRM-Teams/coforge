import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AppError } from "@/lib/app-error";
import { workspaceUserAvatarUrl } from "@/server/db/repositories/user-profile.repositories.server";
import {
  currentIsoWeek,
  emptyReportContent,
  isAssignmentUnread,
  isAutoSendCancelled,
  isWeekSendDismissed,
  isValidTemplateName,
  isValidIsoWeekNumber,
  isHourlySendTime,
  memberReportTitle,
  memberWeekTitle,
  normalizeReportContent,
  reportTabsEqual,
  withAssignmentUnread,
  withAutoSendCancelled,
  withWeekSendDismissed,
  type ReportContent,
} from "@/features/records/records-content";
import {
  looksLikeCollectAgainRequest,
  looksLikeMemberGenerateOfferAccept,
  looksLikeMemberReportRuleIntent,
  looksLikeSideChatGreeting,
  looksLikeSynthesizeWeeklyReportRequest,
  parseRecordAssistantPayload,
  type RecordAssistantPayload,
} from "@/features/records/weekly-highlight-extract";
import {
  canSendWeeklyAssignmentsNow,
  currentWeekTemplateTitle,
  formatOfferSendWeekTitle,
  isWeeklySendArmed,
  splitWeeklyTemplateRoles,
} from "@/features/records/weekly-send-window";
import {
  alignReportContentToSections,
  parseTemplateSections,
  reportContentFromSections,
  sectionsFromReportContent,
  type TemplateOutlineSection,
} from "@/features/records/template-outline-sections";
import { isVisibleTemplateSubmission } from "./template-submission-visibility.server";
import { canEditWeeklyReportContent } from "./weekly-report-editability.server";
import { recipientUserIdsForSend } from "./weekly-report-send-recipients.server";
import {
  isWeeklyScheduleDue,
  zonedCalendarDate,
} from "@/features/records/weekly-report-schedule-due";

type Db = PrismaClient;

function asReportContent(value: unknown): ReportContent {
  return normalizeReportContent(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function requireMembership(db: Db, workspaceId: string, userId: string) {
  const row = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!row) throw new AppError("ACCESS_DENIED");
  return row;
}

type TemplateInput = {
  name: string;
  frequency: "weekly";
  sendTime: string;
  sendWeekday: number;
  scheduleEnabled: boolean;
  sections: TemplateOutlineSection[];
  allMembers: boolean;
  recipientUserIds: string[];
};

/** The columns a template create or update writes from validated input. */
function templateWriteData(input: TemplateInput, sections: TemplateOutlineSection[]) {
  return {
    name: input.name.trim(),
    frequency: input.frequency,
    sendTime: input.sendTime,
    sendWeekday: input.sendWeekday,
    applied: input.scheduleEnabled,
    scheduleEnabled: input.scheduleEnabled,
    dimensions: sections as unknown as Prisma.InputJsonValue,
    mainTitles: [] as string[],
    allMembers: input.allMembers,
    recipients: input.allMembers
      ? undefined
      : { create: input.recipientUserIds.map((userId) => ({ userId })) },
  };
}

export class RecordCatalog {
  constructor(private readonly db: Db) {}

  private async loadFormatSendState(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }): Promise<{
    canSend: boolean;
    schedule: {
      sendWeekday: number;
      sendTime: string;
      scheduleEnabled: boolean;
      autoSendCancelled: boolean;
      alreadySent: boolean;
    } | null;
  }> {
    const now = input.now ?? new Date();
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: { id: true, settingsId: true, content: true },
    });
    if (!report?.settingsId) return { canSend: false, schedule: null };
    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: {
        id: report.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
      },
      select: { id: true, sendWeekday: true, sendTime: true, scheduleEnabled: true },
    });
    if (!settings) return { canSend: false, schedule: null };
    const liveFormat = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: settings.id,
        submissions: { none: { kind: "member" } },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (liveFormat?.id !== input.reportId) return { canSend: false, schedule: null };
    const currentWeek = currentIsoWeek(zonedCalendarDate(now));
    const alreadySent = Boolean(
      await this.db.weeklyReport.findFirst({
        where: {
          workspaceId: input.workspaceId,
          authorId: input.userId,
          kind: "template",
          settingsId: settings.id,
          cycle: { year: currentWeek.year, week: currentWeek.week },
          submissions: { some: { kind: "member" } },
        },
        select: { id: true },
      }),
    );
    const autoSendCancelled = isAutoSendCancelled(
      asReportContent(report.content),
      currentWeek.year,
      currentWeek.week,
    );
    const weekDismissed = isWeekSendDismissed(
      asReportContent(report.content),
      currentWeek.year,
      currentWeek.week,
    );
    const schedule = {
      sendWeekday: settings.sendWeekday,
      sendTime: settings.sendTime,
      scheduleEnabled: settings.scheduleEnabled,
      autoSendCancelled,
      alreadySent,
    };
    return {
      canSend:
        !weekDismissed &&
        canSendWeeklyAssignmentsNow({
          applied: true,
          alreadySent,
          sendWeekday: settings.sendWeekday,
          sendTime: settings.sendTime,
          scheduleEnabled: settings.scheduleEnabled,
          autoSendCancelled,
          now,
        }),
      schedule,
    };
  }

  private async canSendWeeklyAssignments(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }) {
    return (await this.loadFormatSendState(input)).canSend;
  }

  async loadCatalog(input: { workspaceId: string; userId: string; now?: Date }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const [cycles, favorites, notes, me] = await Promise.all([
      this.db.weeklyReportCycle.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ year: "desc" }, { week: "desc" }],
        include: {
          reports: {
            include: {
              author: {
                select: { id: true, username: true, displayName: true, avatarObjectKey: true },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      this.db.weeklyReportFavorite.findMany({
        where: { userId: input.userId, report: { workspaceId: input.workspaceId } },
        include: {
          report: {
            include: {
              author: {
                select: { id: true, username: true, displayName: true, avatarObjectKey: true },
              },
              cycle: { select: { year: true, week: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      this.db.recordNote.findMany({
        where: { workspaceId: input.workspaceId, authorId: input.userId },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: { id: true, title: true, body: true, authorId: true, updatedAt: true },
      }),
      this.db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, username: true, displayName: true, avatarObjectKey: true },
      }),
    ]);

    const now = input.now ?? new Date();
    const templateEntries = cycles
      .flatMap((cycle) =>
        cycle.reports
          .filter((report) => report.kind === "template" && report.authorId === input.userId)
          .map((report) => ({ cycle, report })),
      )
      .sort((left, right) => right.report.createdAt.getTime() - left.report.createdAt.getTime());

    const currentWeek = currentIsoWeek(zonedCalendarDate(now));
    const classified = templateEntries.map(({ cycle, report }) => ({
      year: cycle.year,
      week: cycle.week,
      createdAtMs: report.createdAt.getTime(),
      settingsId: report.settingsId,
      hasAssignments: cycle.reports.some(
        (candidate) => candidate.kind === "member" && candidate.sourceTemplateId === report.id,
      ),
      entry: { cycle, report },
    }));
    const { overviews } = splitWeeklyTemplateRoles(classified);
    const appliedSettings = await this.db.weeklyReportTemplate.findMany({
      where: { workspaceId: input.workspaceId, ownerId: input.userId, applied: true },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        sendWeekday: true,
        sendTime: true,
        scheduleEnabled: true,
        dimensions: true,
      },
    });

    const formatChips: Array<{
      id: string | null;
      settingsId: string | null;
      name: string;
      year: number;
      week: number;
      sendArmed: boolean;
      alreadySent: boolean;
      autoSendCancelled: boolean;
      interactive: boolean;
      appliedSchedule: {
        sendWeekday: number;
        sendTime: string;
        scheduleEnabled: boolean;
      } | null;
    }> = [];
    for (const settings of appliedSettings) {
      const formatReport = await this.ensureFormatForSettings({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: settings.id,
        settingsName: settings.name,
        now,
        sections: parseTemplateSections(settings.dimensions),
      });
      const alreadySentThisWeek = classified.some(
        (row) =>
          row.settingsId === settings.id &&
          row.year === currentWeek.year &&
          row.week === currentWeek.week &&
          row.hasAssignments,
      );
      const formatDoc = await this.db.weeklyReport.findFirst({
        where: { id: formatReport.id },
        select: { content: true },
      });
      const autoSendCancelled = isAutoSendCancelled(
        asReportContent(formatDoc?.content),
        currentWeek.year,
        currentWeek.week,
      );
      const sendArmed = isWeeklySendArmed({
        applied: true,
        alreadySent: alreadySentThisWeek,
        sendWeekday: settings.sendWeekday,
        sendTime: settings.sendTime,
        scheduleEnabled: settings.scheduleEnabled,
        autoSendCancelled,
        now,
      });
      formatChips.push({
        id: formatReport.id,
        settingsId: settings.id,
        name: settings.name,
        year: currentWeek.year,
        week: currentWeek.week,
        sendArmed,
        alreadySent: alreadySentThisWeek,
        autoSendCancelled,
        interactive: true,
        appliedSchedule: {
          sendWeekday: settings.sendWeekday,
          sendTime: settings.sendTime,
          scheduleEnabled: settings.scheduleEnabled,
        },
      });
    }
    if (formatChips.length === 0) {
      formatChips.push({
        id: null,
        settingsId: null,
        name: currentWeekTemplateTitle(currentWeek.year, currentWeek.week),
        year: currentWeek.year,
        week: currentWeek.week,
        sendArmed: false,
        alreadySent: false,
        autoSendCancelled: false,
        interactive: false,
        appliedSchedule: null,
      });
    }

    const memberWeeksMap = new Map<
      string,
      {
        year: number;
        week: number;
        title: string;
        cycleId: string;
        overviewReportId: string;
        submissions: Array<{
          id: string;
          title: string;
          status: string;
          submittedAt: string | null;
          sourceTemplateId: string | null;
          author: {
            userId: string;
            username: string;
            displayName: string;
            avatarUrl: string | null;
          };
        }>;
      }
    >();
    for (const {
      entry: { cycle, report },
    } of overviews) {
      const key = `${cycle.year}-${cycle.week}`;
      let week = memberWeeksMap.get(key);
      if (!week) {
        week = {
          year: cycle.year,
          week: cycle.week,
          title: memberWeekTitle(cycle.year, cycle.week),
          cycleId: cycle.id,
          overviewReportId: report.id,
          submissions: [],
        };
        memberWeeksMap.set(key, week);
      }
      for (const candidate of cycle.reports) {
        if (
          candidate.kind !== "member" ||
          candidate.sourceTemplateId !== report.id ||
          !isVisibleTemplateSubmission(candidate.status)
        ) {
          continue;
        }
        if (week.submissions.some((row) => row.id === candidate.id)) continue;
        const displayName = candidate.author.displayName ?? candidate.author.username;
        week.submissions.push({
          id: candidate.id,
          title: memberReportTitle(displayName, cycle.year, cycle.week),
          status: candidate.status,
          submittedAt:
            candidate.submittedAt instanceof Date ? candidate.submittedAt.toISOString() : null,
          sourceTemplateId: candidate.sourceTemplateId,
          author: {
            userId: candidate.author.id,
            username: candidate.author.username,
            displayName,
            avatarUrl: workspaceUserAvatarUrl(
              input.workspaceId,
              candidate.author.id,
              candidate.author.avatarObjectKey,
            ),
          },
        });
      }
    }
    const memberWeeks = [...memberWeeksMap.values()].sort((left, right) =>
      left.year !== right.year ? right.year - left.year : right.week - left.week,
    );

    return {
      actorUserId: input.userId,
      actorDisplayName: me?.displayName ?? me?.username ?? "",
      actorAvatarUrl: me
        ? workspaceUserAvatarUrl(input.workspaceId, me.id, me.avatarObjectKey)
        : null,
      favorites: favorites
        .filter((row) => !(row.report.authorId === input.userId && row.report.hiddenFromAuthor))
        .map((row) => ({
          id: row.report.id,
          title: memberReportTitle(
            row.report.author.displayName ?? row.report.author.username,
            row.report.cycle.year,
            row.report.cycle.week,
          ),
          author: {
            userId: row.report.author.id,
            username: row.report.author.username,
            displayName: row.report.author.displayName ?? row.report.author.username,
            avatarUrl: workspaceUserAvatarUrl(
              input.workspaceId,
              row.report.author.id,
              row.report.author.avatarObjectKey,
            ),
          },
        })),
      myReports: cycles.flatMap((cycle) =>
        cycle.reports
          .filter(
            (report) =>
              report.kind === "member" &&
              report.authorId === input.userId &&
              !report.hiddenFromAuthor,
          )
          .map((report) => ({
            id: report.id,
            title: memberReportTitle(
              me?.displayName ?? me?.username ?? report.title,
              cycle.year,
              cycle.week,
            ),
            status: report.status,
            unread: isAssignmentUnread(asReportContent(report.content)),
            sourceTemplateId: report.sourceTemplateId,
            year: cycle.year,
            week: cycle.week,
          })),
      ),
      memberWeeks,
      formatChips,
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        preview: note.body.slice(0, 80),
        authorId: note.authorId,
        updatedAt: note.updatedAt.toISOString(),
      })),
    };
  }

  /** Records rail dot: Leader preview hour, or an unread member assignment. */
  async loadNavAttention(input: { workspaceId: string; userId: string; now?: Date }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const unreadAssignment = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
        sourceTemplateId: { not: null },
        hiddenFromAuthor: false,
        content: { path: ["assignment", "unread"], equals: true },
      },
      select: { id: true },
    });
    if (unreadAssignment) return { preview: true as const };

    const now = input.now ?? new Date();
    const currentWeek = currentIsoWeek(zonedCalendarDate(now));
    const settings = await this.db.weeklyReportTemplate.findMany({
      where: {
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
        scheduleEnabled: true,
      },
      select: { id: true, sendWeekday: true, sendTime: true },
    });
    if (settings.length === 0) return { preview: false as const };
    const stream = {
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "template" as const,
      settingsId: { in: settings.map((row) => row.id) },
    };
    const [sent, live] = await Promise.all([
      this.db.weeklyReport.findMany({
        where: {
          ...stream,
          cycle: { year: currentWeek.year, week: currentWeek.week },
          submissions: { some: { kind: "member" } },
        },
        select: { settingsId: true },
      }),
      this.db.weeklyReport.findMany({
        where: { ...stream, submissions: { none: { kind: "member" } } },
        select: { settingsId: true, content: true },
      }),
    ]);
    const sentSettingsIds = new Set(sent.map((row) => row.settingsId));
    const liveContentBySettingsId = new Map<string | null, unknown>();
    for (const row of live) {
      if (!liveContentBySettingsId.has(row.settingsId))
        liveContentBySettingsId.set(row.settingsId, row.content);
    }
    for (const row of settings) {
      const armed = isWeeklySendArmed({
        applied: true,
        alreadySent: sentSettingsIds.has(row.id),
        sendWeekday: row.sendWeekday,
        sendTime: row.sendTime,
        scheduleEnabled: true,
        autoSendCancelled: isAutoSendCancelled(
          asReportContent(liveContentBySettingsId.get(row.id)),
          currentWeek.year,
          currentWeek.week,
        ),
        now,
      });
      if (armed) return { preview: true as const };
    }
    return { preview: false as const };
  }

  /**
   * Ensure a live format document for one applied settings stream (no assignments).
   */
  private async ensureFormatForSettings(input: {
    workspaceId: string;
    userId: string;
    settingsId: string;
    settingsName: string;
    now?: Date;
    sections?: TemplateOutlineSection[];
    alignContent?: boolean;
  }): Promise<{ id: string }> {
    const linked = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: input.settingsId,
        submissions: { none: { kind: "member" } },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (linked) {
      if (input.alignContent && input.sections && input.sections.length > 0) {
        await this.syncFormatReportToSections({
          workspaceId: input.workspaceId,
          userId: input.userId,
          reportId: linked.id,
          sections: input.sections,
        });
      }
      const current = await this.db.weeklyReport.findFirst({
        where: { id: linked.id },
        select: { title: true },
      });
      if (current && current.title !== input.settingsName) {
        await this.db.weeklyReport.update({
          where: { id: linked.id },
          data: { title: input.settingsName },
        });
      }
      return linked;
    }

    const orphan = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: null,
        submissions: { none: { kind: "member" } },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (orphan) {
      await this.db.weeklyReport.update({
        where: { id: orphan.id },
        data: { settingsId: input.settingsId, title: input.settingsName },
      });
      if (input.alignContent && input.sections && input.sections.length > 0) {
        await this.syncFormatReportToSections({
          workspaceId: input.workspaceId,
          userId: input.userId,
          reportId: orphan.id,
          sections: input.sections,
        });
      }
      return orphan;
    }

    const cycle = await this.ensureCurrentCycle({
      workspaceId: input.workspaceId,
      userId: input.userId,
      now: input.now,
    });
    const baseContent =
      input.sections && input.sections.length > 0
        ? reportContentFromSections(input.sections)
        : emptyReportContent();
    const prior = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: input.settingsId,
      },
      orderBy: { updatedAt: "desc" },
      select: { content: true },
    });
    const priorPrompts = prior ? asReportContent(prior.content).keyPointPrompts : undefined;
    const content = priorPrompts ? { ...baseContent, keyPointPrompts: priorPrompts } : baseContent;
    const created = await this.db.weeklyReport.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        authorId: input.userId,
        settingsId: input.settingsId,
        kind: "template",
        title: input.settingsName,
        status: "draft",
        content: content as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return created;
  }

  private async syncFormatReportToSections(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    sections: TemplateOutlineSection[];
  }) {
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        submissions: { none: { kind: "member" } },
      },
      select: { id: true, content: true },
    });
    if (!report) return;
    const next = alignReportContentToSections(asReportContent(report.content), input.sections);
    await this.db.weeklyReport.update({
      where: { id: report.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
  }

  private async syncSettingsOutlineFromFormat(input: {
    workspaceId: string;
    userId: string;
    settingsId: string;
    content: ReportContent;
  }) {
    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: {
        id: input.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
      },
      select: { id: true },
    });
    if (!settings) return;
    const sections = sectionsFromReportContent(input.content);
    await this.db.weeklyReportTemplate.update({
      where: { id: settings.id },
      data: {
        dimensions: sections as unknown as Prisma.InputJsonValue,
        mainTitles: [],
      },
    });
  }

  async ensureCurrentCycle(input: {
    workspaceId: string;
    userId: string;
    now?: Date;
  }): Promise<{ id: string; year: number; week: number; title: string; created: boolean }> {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const { year, week } = currentIsoWeek(input.now ?? new Date());
    return this.ensureCycleAt({
      workspaceId: input.workspaceId,
      userId: input.userId,
      year,
      week,
    });
  }

  /** Find or create the Workspace ISO-week bucket for `(year, week)`. */
  async ensureCycleAt(input: {
    workspaceId: string;
    userId: string;
    year: number;
    week: number;
  }): Promise<{ id: string; year: number; week: number; title: string; created: boolean }> {
    await requireMembership(this.db, input.workspaceId, input.userId);
    if (!isValidIsoWeekNumber(input.week) || !Number.isInteger(input.year)) {
      throw new AppError("INVALID_INPUT");
    }
    const title = memberWeekTitle(input.year, input.week);
    const existing = await this.db.weeklyReportCycle.findUnique({
      where: {
        workspaceId_year_week: {
          workspaceId: input.workspaceId,
          year: input.year,
          week: input.week,
        },
      },
      select: { id: true, year: true, week: true, title: true },
    });
    if (existing) {
      return {
        id: existing.id,
        year: existing.year,
        week: existing.week,
        title: existing.title,
        created: false,
      };
    }
    const cycle = await this.db.weeklyReportCycle.create({
      data: {
        workspaceId: input.workspaceId,
        year: input.year,
        week: input.week,
        title,
        createdById: input.userId,
      },
      select: { id: true, year: true, week: true, title: true },
    });
    return { id: cycle.id, year: cycle.year, week: cycle.week, title: cycle.title, created: true };
  }

  /**
   * Rename the live format document (and its settings stream). ISO week stays
   * calendar-owned; overview parents with member submissions are rejected.
   */
  async updateFormatReportMeta(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    title: string;
  }): Promise<{ id: string; title: string; year: number; week: number }> {
    await requireMembership(this.db, input.workspaceId, input.userId);
    if (!isValidTemplateName(input.title)) throw new AppError("INVALID_INPUT");
    const title = input.title.trim();
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: {
        id: true,
        authorId: true,
        kind: true,
        title: true,
        settingsId: true,
        cycle: { select: { year: true, week: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report || report.kind !== "template") throw new AppError("NOT_FOUND");
    if (report.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    // Sent week overviews have member children; only the live format chip may rename.
    if (report.submissions.length > 0) throw new AppError("ACCESS_DENIED");

    if (title !== report.title) {
      await this.db.weeklyReport.update({
        where: { id: report.id },
        data: { title },
      });
      if (report.settingsId) {
        await this.db.weeklyReportTemplate.update({
          where: { id: report.settingsId },
          data: { name: title },
        });
      }
    }
    return {
      id: report.id,
      title,
      year: report.cycle.year,
      week: report.cycle.week,
    };
  }

  /**
   * Create a member assignment under a Leader weekly parent (send path).
   * Drafts are not listed as children until submitted; see ADR 0011.
   */
  async createSubmissionUnderTemplate(input: {
    workspaceId: string;
    userId: string;
    templateId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const template = await this.db.weeklyReport.findFirst({
      where: {
        id: input.templateId,
        workspaceId: input.workspaceId,
        kind: "template",
      },
      select: {
        id: true,
        content: true,
        cycle: { select: { id: true, year: true, week: true } },
      },
    });
    if (!template) throw new AppError("NOT_FOUND");
    const author = await this.db.user.findUnique({
      where: { id: input.userId },
      select: { displayName: true, username: true },
    });
    const displayName = author?.displayName ?? author?.username ?? "Member";
    const title = memberReportTitle(displayName, template.cycle.year, template.cycle.week);
    const report = await this.db.weeklyReport.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: template.cycle.id,
        authorId: input.userId,
        kind: "member",
        sourceTemplateId: template.id,
        title,
        status: "draft",
        content: withAssignmentUnread(
          asReportContent(template.content),
          true,
        ) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, title: true },
    });
    return {
      id: report.id,
      cycleId: template.cycle.id,
      title: report.title,
      year: template.cycle.year,
      week: template.cycle.week,
      kind: "member" as const,
      sourceTemplateId: template.id,
      created: true,
    };
  }

  /**
   * Leader manual send: persist source content, create a new weekly parent for the
   * current cycle, and open unread assignments for configured recipients (ADR 0011).
   */
  async sendWeeklyAssignments(input: {
    workspaceId: string;
    userId: string;
    sourceReportId: string;
    content?: ReportContent;
    now?: Date;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const source = await this.db.weeklyReport.findFirst({
      where: {
        id: input.sourceReportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true, content: true, settingsId: true },
    });
    if (!source?.settingsId) throw new AppError("NOT_FOUND");

    const content = normalizeReportContent(input.content ?? asReportContent(source.content));
    if (input.content) {
      await this.db.weeklyReport.update({
        where: { id: source.id },
        data: { content: content as unknown as Prisma.InputJsonValue },
      });
    }

    const sendSettings = await this.db.weeklyReportTemplate.findFirst({
      where: {
        id: source.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
      },
      include: { recipients: { select: { userId: true } } },
    });
    if (!sendSettings) throw new AppError("INVALID_INPUT", { errorId: "weekly-send-no-settings" });

    const memberships = await this.db.workspaceMembership.findMany({
      where: { workspaceId: input.workspaceId },
      select: { userId: true },
    });
    const recipientIds = recipientUserIdsForSend({
      allMembers: sendSettings.allMembers,
      recipientUserIds: sendSettings.recipients.map((row) => row.userId),
      workspaceMemberIds: memberships.map((row) => row.userId),
      senderUserId: input.userId,
    });
    if (recipientIds.length === 0) {
      throw new AppError("INVALID_INPUT", { errorId: "weekly-send-no-recipients" });
    }

    const cycle = await this.ensureCurrentCycle(input);
    const parent = await this.db.weeklyReport.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        authorId: input.userId,
        settingsId: source.settingsId,
        kind: "template",
        title: memberWeekTitle(cycle.year, cycle.week),
        status: "draft",
        content: content as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, title: true },
    });

    const recipients = await this.db.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, displayName: true, username: true },
    });
    const byId = new Map(recipients.map((user) => [user.id, user]));

    let assignmentCount = 0;
    for (const memberId of recipientIds) {
      const member = byId.get(memberId);
      if (!member) continue;
      const displayName = member.displayName ?? member.username;
      await this.db.weeklyReport.create({
        data: {
          workspaceId: input.workspaceId,
          cycleId: cycle.id,
          authorId: memberId,
          kind: "member",
          sourceTemplateId: parent.id,
          title: memberReportTitle(displayName, cycle.year, cycle.week),
          status: "draft",
          content: withAssignmentUnread(content, true) as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      assignmentCount += 1;
    }

    if (assignmentCount === 0) {
      throw new AppError("INVALID_INPUT", { errorId: "weekly-send-no-recipients" });
    }

    return {
      parentId: parent.id,
      title: parent.title,
      year: cycle.year,
      week: cycle.week,
      assignmentCount,
    };
  }

  /**
   * Cron entry: for each applied+scheduleEnabled settings row that is due now,
   * reuse sendWeeklyAssignments once per ISO week (skip if that cycle already has
   * Leader-sent assignments).
   */
  async runDueScheduledWeeklyAssignments(input: { now?: Date } = {}) {
    const now = input.now ?? new Date();
    const settings = await this.db.weeklyReportTemplate.findMany({
      where: { applied: true, scheduleEnabled: true, frequency: "weekly" },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        ownerId: true,
        sendTime: true,
        sendWeekday: true,
      },
    });

    const results: Array<{
      workspaceId: string;
      templateId: string;
      status: "sent" | "skipped" | "failed";
      reason?: string;
      parentId?: string;
      assignmentCount?: number;
    }> = [];

    for (const row of settings) {
      if (
        !isWeeklyScheduleDue({
          now,
          sendWeekday: row.sendWeekday,
          sendTime: row.sendTime,
        })
      ) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "not-due",
        });
        continue;
      }

      const scheduleNow = zonedCalendarDate(now);
      const { year, week } = currentIsoWeek(scheduleNow);
      const alreadySent = await this.db.weeklyReport.findFirst({
        where: {
          workspaceId: row.workspaceId,
          kind: "template",
          authorId: row.ownerId,
          settingsId: row.id,
          cycle: { year, week },
          submissions: { some: { kind: "member" } },
        },
        select: { id: true },
      });
      if (alreadySent) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "already-sent",
        });
        continue;
      }

      const liveFormat = await this.db.weeklyReport.findFirst({
        where: {
          workspaceId: row.workspaceId,
          authorId: row.ownerId,
          kind: "template",
          settingsId: row.id,
          submissions: { none: { kind: "member" } },
        },
        select: { content: true },
      });
      if (liveFormat && isAutoSendCancelled(asReportContent(liveFormat.content), year, week)) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "auto-send-cancelled",
        });
        continue;
      }

      const source = await this.ensureFormatForSettings({
        workspaceId: row.workspaceId,
        userId: row.ownerId,
        settingsId: row.id,
        settingsName: row.name,
        now: scheduleNow,
      });

      const membership = await this.db.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: row.workspaceId, userId: row.ownerId },
        },
        select: { userId: true },
      });
      if (!membership) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "source-author-not-member",
        });
        continue;
      }

      try {
        const sent = await this.sendWeeklyAssignments({
          workspaceId: row.workspaceId,
          userId: row.ownerId,
          sourceReportId: source.id,
          now: scheduleNow,
        });
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "sent",
          parentId: sent.parentId,
          assignmentCount: sent.assignmentCount,
        });
      } catch (error) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "failed",
          reason: error instanceof Error ? error.message : "send-failed",
        });
      }
    }

    return {
      checkedAt: now.toISOString(),
      sent: results.filter((row) => row.status === "sent").length,
      results,
    };
  }

  async deleteMemberReport(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: { id: true, status: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (report.status === "submitted" || report.status === "shared") {
      await this.db.weeklyReport.update({
        where: { id: report.id },
        data: { hiddenFromAuthor: true },
      });
      return { ok: true as const };
    }
    await this.db.weeklyReport.delete({ where: { id: report.id } });
    return { ok: true as const };
  }

  async setReportFavorite(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    favorited: boolean;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
      },
      select: {
        id: true,
        authorId: true,
        sourceTemplate: { select: { authorId: true } },
      },
    });
    if (!report) throw new AppError("NOT_FOUND");
    const canAccess =
      report.authorId === input.userId || report.sourceTemplate?.authorId === input.userId;
    if (!canAccess) {
      const favorite = await this.db.weeklyReportFavorite.findUnique({
        where: { userId_reportId: { userId: input.userId, reportId: report.id } },
        select: { reportId: true },
      });
      if (!favorite) throw new AppError("NOT_FOUND");
    }

    if (input.favorited) {
      await this.db.weeklyReportFavorite.upsert({
        where: {
          userId_reportId: { userId: input.userId, reportId: report.id },
        },
        create: { userId: input.userId, reportId: report.id },
        update: {},
      });
      return { favorited: true as const };
    }

    await this.db.weeklyReportFavorite.deleteMany({
      where: { userId: input.userId, reportId: report.id },
    });
    return { favorited: false as const };
  }

  async deleteTemplateReport(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    await this.db.weeklyReport.delete({ where: { id: report.id } });
    return { ok: true as const };
  }

  async deleteCycle(input: { workspaceId: string; userId: string; cycleId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const cycle = await this.db.weeklyReportCycle.findFirst({
      where: { id: input.cycleId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!cycle) throw new AppError("NOT_FOUND");
    await this.db.weeklyReportCycle.delete({ where: { id: cycle.id } });
    return { ok: true as const };
  }

  /**
   * Deletes the Leader's overview week node only. Member submissions stay so
   * the author's「我的周报」copy and any「已收藏的周报」row remain; they are
   * unlinked from this parent so they leave the Leader's member-week tree.
   * The live format template in the same cycle is not this node.
   * Stamps auto-send cancelled for this ISO week on the live format so cron
   * does not recreate the week (ADR 0012); manual send remains available.
   */
  async deleteOverviewReport(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const overview = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: {
        id: true,
        cycleId: true,
        settingsId: true,
        cycle: { select: { year: true, week: true } },
      },
    });
    if (!overview) throw new AppError("NOT_FOUND");

    await this.db.$transaction(async (tx) => {
      await tx.weeklyReport.updateMany({
        where: {
          workspaceId: input.workspaceId,
          kind: "member",
          sourceTemplateId: overview.id,
        },
        data: { sourceTemplateId: null },
      });
      await tx.weeklyReport.deleteMany({ where: { id: { in: [overview.id] } } });
      const remaining = await tx.weeklyReport.count({
        where: { workspaceId: input.workspaceId, cycleId: overview.cycleId },
      });
      if (remaining === 0) {
        await tx.weeklyReportCycle.delete({ where: { id: overview.cycleId } });
      }
    });

    await this.cancelScheduledSendForWeek({
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: overview.settingsId,
      year: overview.cycle.year,
      week: overview.cycle.week,
    });
    return { ok: true as const };
  }

  /**
   * Deletes the viewer's「成员周报」week node scope for one ISO week: their
   * template parents in that cycle and member submissions under those parents.
   * Other leaders' templates/submissions are left alone. The cycle row is
   * removed only when nothing remains.
   * Cancels auto-send for each deleted settings stream's ISO week (ADR 0012).
   */
  async deleteMemberWeek(input: { workspaceId: string; userId: string; cycleId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const cycle = await this.db.weeklyReportCycle.findFirst({
      where: { id: input.cycleId, workspaceId: input.workspaceId },
      select: { id: true, year: true, week: true },
    });
    if (!cycle) throw new AppError("NOT_FOUND");

    const myTemplates = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true, settingsId: true },
    });
    if (myTemplates.length === 0) throw new AppError("NOT_FOUND");
    const templateIds = myTemplates.map((row) => row.id);
    const settingsIds = [
      ...new Set(
        myTemplates
          .map((row) => row.settingsId)
          .filter((settingsId): settingsId is string => Boolean(settingsId)),
      ),
    ];

    const submissions = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        kind: "member",
        sourceTemplateId: { in: templateIds },
      },
      select: { id: true },
    });

    const reportIds = [...submissions.map((row) => row.id), ...templateIds];
    await this.db.$transaction(async (tx) => {
      if (reportIds.length > 0) {
        await tx.weeklyReport.deleteMany({ where: { id: { in: reportIds } } });
      }
      const remaining = await tx.weeklyReport.count({
        where: { workspaceId: input.workspaceId, cycleId: cycle.id },
      });
      if (remaining === 0) {
        await tx.weeklyReportCycle.delete({ where: { id: cycle.id } });
      }
    });

    for (const settingsId of settingsIds) {
      await this.cancelScheduledSendForWeek({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId,
        year: cycle.year,
        week: cycle.week,
      });
    }
    return { ok: true as const };
  }

  /**
   * After a Leader deletes a sent week, stamp the live format so cron skips
   * that ISO week (ADR 0012). No-op when there is no settings stream or live
   * format yet; ensureFormat will still see a later cancel only if stamped.
   */
  private async cancelScheduledSendForWeek(input: {
    workspaceId: string;
    userId: string;
    settingsId: string | null;
    year: number;
    week: number;
  }) {
    if (!input.settingsId) return;
    const liveFormat = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: input.settingsId,
        submissions: { none: { kind: "member" } },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, content: true },
    });
    if (!liveFormat) return;
    const next = withAutoSendCancelled(asReportContent(liveFormat.content), input.year, input.week);
    await this.db.weeklyReport.update({
      where: { id: liveFormat.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
  }

  async loadAssistantContextManifest(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);

    if (input.subjectType === "report") {
      const subject = await this.getSubject({
        workspaceId: input.workspaceId,
        userId: input.userId,
        id: input.subjectId,
      });
      if (subject.type !== "report") throw new AppError("NOT_FOUND");
      return {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        cycle: subject.report.cycle,
        status: subject.report.status,
        structure: Object.keys(subject.report.content.tabs ?? {}),
        availableData: [
          "current_report",
          "template",
          "submission_status",
          "visible_member_reports",
          "favorites",
        ],
        contextVersion: subject.report.updatedAt,
      } as const;
    }

    const cycle = await this.db.weeklyReportCycle.findFirst({
      where: { id: input.subjectId, workspaceId: input.workspaceId },
      select: {
        id: true,
        year: true,
        week: true,
        title: true,
        createdAt: true,
        _count: { select: { reports: true } },
      },
    });
    if (!cycle) throw new AppError("NOT_FOUND");
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      cycle: { id: cycle.id, year: cycle.year, week: cycle.week, title: cycle.title },
      structure: [],
      availableData: ["cycle", "visible_member_reports", "submission_status"],
      reportCount: cycle._count.reports,
      contextVersion: cycle.createdAt.toISOString(),
    } as const;
  }

  async listAssistantVisibleReports(input: {
    workspaceId: string;
    userId: string;
    cycleId?: string;
    cursor?: string;
    limit?: number;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
    const rows = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
        kind: "member",
        status: { in: ["submitted", "shared"] },
        OR: [{ authorId: input.userId }, { sourceTemplate: { authorId: input.userId } }],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
      take: limit + 1,
      select: {
        id: true,
        cycleId: true,
        authorId: true,
        title: true,
        status: true,
        submittedAt: true,
        updatedAt: true,
        author: { select: { username: true, displayName: true } },
        cycle: { select: { year: true, week: true, title: true } },
      },
    });
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    return {
      reports: visible.map((row) => ({
        id: row.id,
        cycleId: row.cycleId,
        title: row.title,
        status: row.status,
        submittedAt: row.submittedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        author: {
          username: row.author.username,
          displayName: row.author.displayName ?? row.author.username,
        },
        cycle: row.cycle,
        source: {
          kind: "weekly_report",
          reportId: row.id,
          userId: row.authorId,
        },
      })),
      nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
    } as const;
  }

  async readAssistantReportSection(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    section: string;
    maxCharacters?: number;
  }) {
    const subject = await this.getSubject({
      workspaceId: input.workspaceId,
      userId: input.userId,
      id: input.reportId,
    });
    if (subject.type !== "report") throw new AppError("NOT_FOUND");
    const section = input.section.trim();
    const tab = subject.report.content.tabs?.[section];
    if (!tab) throw new AppError("NOT_FOUND");
    const maxCharacters = Math.max(1, Math.min(input.maxCharacters ?? 12_000, 12_000));
    const markdown = tab.markdown.slice(0, maxCharacters);
    return {
      reportId: input.reportId,
      section,
      markdown,
      truncated: markdown.length < tab.markdown.length,
      source: {
        kind: "weekly_report",
        reportId: input.reportId,
        userId: subject.report.author.userId,
        displayName: subject.report.author.displayName,
        cycle: subject.report.cycle,
      },
    } as const;
  }

  async getSubject(input: { workspaceId: string; userId: string; id: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarObjectKey: true },
        },
        cycle: { select: { id: true, year: true, week: true, title: true } },
        sourceTemplate: {
          select: {
            authorId: true,
            author: {
              select: { id: true, username: true, displayName: true, avatarObjectKey: true },
            },
          },
        },
      },
    });
    if (report) {
      if (report.kind === "template") {
        if (report.author.id !== input.userId) {
          const assignment = await this.db.weeklyReport.findFirst({
            where: {
              workspaceId: input.workspaceId,
              sourceTemplateId: report.id,
              kind: "member",
              authorId: input.userId,
            },
            select: { id: true },
          });
          if (!assignment) throw new AppError("NOT_FOUND");
        }
      } else if (report.kind === "member") {
        const isAuthor = report.author.id === input.userId;
        const isTemplateOwner = report.sourceTemplate?.authorId === input.userId;
        if (report.hiddenFromAuthor && isAuthor) throw new AppError("NOT_FOUND");
        if (!isAuthor && !isTemplateOwner) {
          const favorite = await this.db.weeklyReportFavorite.findUnique({
            where: {
              userId_reportId: { userId: input.userId, reportId: report.id },
            },
            select: { reportId: true },
          });
          if (!favorite) throw new AppError("NOT_FOUND");
        }
      }

      const isTemplateAuthor = report.author.id === input.userId;
      const content = asReportContent(report.content);
      const assignmentCount =
        report.kind === "template"
          ? await this.db.weeklyReport.count({
              where: {
                workspaceId: input.workspaceId,
                sourceTemplateId: report.id,
                kind: "member",
              },
            })
          : 0;
      const surface =
        report.kind === "template"
          ? assignmentCount > 0
            ? ("overview" as const)
            : ("format" as const)
          : undefined;
      const children =
        report.kind === "template"
          ? (
              await this.db.weeklyReport.findMany({
                where: {
                  workspaceId: input.workspaceId,
                  sourceTemplateId: report.id,
                  kind: "member",
                  // Overview lists every assignment; draft rows stay non-clickable in the UI.
                  ...(isTemplateAuthor ? {} : { authorId: input.userId }),
                },
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  submittedAt: true,
                  author: {
                    select: { id: true, username: true, displayName: true, avatarObjectKey: true },
                  },
                },
              })
            ).map((child) => ({
              id: child.id,
              title: memberReportTitle(
                child.author.displayName ?? child.author.username,
                report.cycle.year,
                report.cycle.week,
              ),
              status: child.status,
              submittedAt: child.submittedAt?.toISOString() ?? null,
              author: {
                userId: child.author.id,
                username: child.author.username,
                displayName: child.author.displayName ?? child.author.username,
                avatarUrl: workspaceUserAvatarUrl(
                  input.workspaceId,
                  child.author.id,
                  child.author.avatarObjectKey,
                ),
              },
            }))
          : [];
      return {
        type: "report" as const,
        report: {
          id: report.id,
          kind: report.kind,
          title:
            report.kind === "member"
              ? memberReportTitle(
                  report.author.displayName ?? report.author.username,
                  report.cycle.year,
                  report.cycle.week,
                )
              : report.title,
          status: report.status,
          content,
          submittedAt: report.submittedAt?.toISOString() ?? null,
          updatedAt: report.updatedAt.toISOString(),
          author: {
            userId: report.author.id,
            username: report.author.username,
            displayName: report.author.displayName ?? report.author.username,
            avatarUrl: workspaceUserAvatarUrl(
              input.workspaceId,
              report.author.id,
              report.author.avatarObjectKey,
            ),
          },
          sharedBy:
            report.kind === "member" && report.sourceTemplate?.author
              ? {
                  userId: report.sourceTemplate.author.id,
                  username: report.sourceTemplate.author.username,
                  displayName:
                    report.sourceTemplate.author.displayName ??
                    report.sourceTemplate.author.username,
                  avatarUrl: workspaceUserAvatarUrl(
                    input.workspaceId,
                    report.sourceTemplate.author.id,
                    report.sourceTemplate.author.avatarObjectKey,
                  ),
                }
              : null,
          cycle: report.cycle,
          sourceTemplateId: report.sourceTemplateId,
          unread: isAssignmentUnread(content),
          editable: canEditWeeklyReportContent({
            viewerUserId: input.userId,
            authorUserId: report.author.id,
          }),
          surface,
          canSendAssignments:
            report.kind === "template" && surface === "format"
              ? await this.canSendWeeklyAssignments({
                  workspaceId: input.workspaceId,
                  userId: input.userId,
                  reportId: report.id,
                })
              : false,
          sendSchedule:
            report.kind === "template" && surface === "format"
              ? (
                  await this.loadFormatSendState({
                    workspaceId: input.workspaceId,
                    userId: input.userId,
                    reportId: report.id,
                  })
                ).schedule
              : undefined,
          favorited:
            report.kind === "member"
              ? Boolean(
                  await this.db.weeklyReportFavorite.findUnique({
                    where: {
                      userId_reportId: { userId: input.userId, reportId: report.id },
                    },
                    select: { reportId: true },
                  }),
                )
              : false,
          children,
        },
      };
    }

    const note = await this.db.recordNote.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
      include: {
        author: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (note) {
      if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
      return {
        type: "note" as const,
        note: {
          id: note.id,
          title: note.title,
          body: note.body,
          updatedAt: note.updatedAt.toISOString(),
          author: {
            userId: note.author.id,
            username: note.author.username,
            displayName: note.author.displayName ?? note.author.username,
          },
        },
      };
    }

    throw new AppError("NOT_FOUND");
  }

  /** Create a personal workspace note (Markdown body). */
  async createNote(input: { workspaceId: string; userId: string; title?: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const title = (input.title?.trim() || "Untitled").slice(0, 200);
    const note = await this.db.recordNote.create({
      data: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        title,
        body: "",
      },
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt.toISOString(),
      created: true as const,
    };
  }

  async saveNote(input: {
    workspaceId: string;
    userId: string;
    noteId: string;
    title?: string;
    body?: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const note = await this.db.recordNote.findFirst({
      where: { id: input.noteId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true },
    });
    if (!note) throw new AppError("NOT_FOUND");
    if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    const data: { title?: string; body?: string } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new AppError("INVALID_INPUT");
      data.title = title.slice(0, 200);
    }
    if (input.body !== undefined) data.body = input.body;
    if (!Object.keys(data).length) {
      const current = await this.db.recordNote.findUniqueOrThrow({
        where: { id: note.id },
        select: { id: true, title: true, updatedAt: true },
      });
      return {
        id: current.id,
        title: current.title,
        updatedAt: current.updatedAt.toISOString(),
      };
    }
    const updated = await this.db.recordNote.update({
      where: { id: note.id },
      data,
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      id: updated.id,
      title: updated.title,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async deleteNote(input: { workspaceId: string; userId: string; noteId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const note = await this.db.recordNote.findFirst({
      where: { id: input.noteId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true },
    });
    if (!note) throw new AppError("NOT_FOUND");
    if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    await this.db.recordNote.delete({ where: { id: note.id } });
    return { ok: true as const };
  }

  async markAssignmentOpened(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: { id: true, content: true, sourceTemplateId: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (!report.sourceTemplateId) return { id: report.id, unread: false as const };
    const content = asReportContent(report.content);
    if (!isAssignmentUnread(content)) return { id: report.id, unread: false as const };
    const next = withAssignmentUnread(content, false);
    await this.db.weeklyReport.update({
      where: { id: report.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
    return { id: report.id, unread: false as const };
  }

  async saveReportContent(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    content: ReportContent;
    status?: "draft" | "submitted" | "shared";
    now?: Date;
    /** Explicit「保存」: ask assistant whether to send when still eligible. */
    askToSend?: boolean;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: {
        id: true,
        authorId: true,
        kind: true,
        status: true,
        hiddenFromAuthor: true,
        settingsId: true,
        content: true,
        cycle: { select: { year: true, week: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (report.kind === "member" && report.hiddenFromAuthor) throw new AppError("NOT_FOUND");
    if (
      !canEditWeeklyReportContent({
        viewerUserId: input.userId,
        authorUserId: report.authorId,
      })
    ) {
      throw new AppError("ACCESS_DENIED");
    }
    const stored = asReportContent(report.content);
    let content = normalizeReportContent(input.content);
    if (stored.schedule && !content.schedule) {
      content = { ...content, schedule: stored.schedule };
    }
    if (stored.keyPointPrompts && !content.keyPointPrompts) {
      content = { ...content, keyPointPrompts: stored.keyPointPrompts };
    }
    if (stored.keyPointExtraction && !content.keyPointExtraction) {
      content = { ...content, keyPointExtraction: stored.keyPointExtraction };
    }
    const now = input.now ?? new Date();
    const week = report.cycle ?? currentIsoWeek(zonedCalendarDate(now));
    const wasCancelled = isAutoSendCancelled(stored, week.year, week.week);
    let autoSendJustCancelled = false;
    if (
      report.kind === "template" &&
      report.submissions.length === 0 &&
      report.settingsId &&
      !reportTabsEqual(stored, content)
    ) {
      const settings = await this.db.weeklyReportTemplate.findFirst({
        where: {
          id: report.settingsId,
          workspaceId: input.workspaceId,
          ownerId: input.userId,
        },
        select: { sendWeekday: true, sendTime: true, scheduleEnabled: true },
      });
      if (
        settings?.scheduleEnabled &&
        canSendWeeklyAssignmentsNow({
          applied: true,
          alreadySent: false,
          sendWeekday: settings.sendWeekday,
          sendTime: settings.sendTime,
          scheduleEnabled: true,
          now,
        })
      ) {
        content = withAutoSendCancelled(content, week.year, week.week);
        autoSendJustCancelled = !wasCancelled;
      }
    }
    const updated = await this.db.weeklyReport.update({
      where: { id: report.id },
      data: {
        content: content as unknown as Prisma.InputJsonValue,
        ...(input.status
          ? {
              status: input.status,
              submittedAt:
                input.status === "submitted" || input.status === "shared" ? new Date() : null,
            }
          : {}),
      },
    });
    if (report.kind === "template" && report.submissions.length === 0 && report.settingsId) {
      await this.syncSettingsOutlineFromFormat({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: report.settingsId,
        content,
      });
    }

    let assistantPosted = false;
    if (report.kind === "template" && report.submissions.length === 0) {
      if (autoSendJustCancelled) {
        await this.writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: report.id,
          body: "已取消本周自动发送。保存后请手动发送周报模板。",
        });
        assistantPosted = true;
      }
      if (input.askToSend) {
        const offer = await this.buildFormatOfferSend({
          workspaceId: input.workspaceId,
          userId: input.userId,
          reportId: report.id,
          now,
        });
        if (offer) {
          await this.writeAssistantComment({
            workspaceId: input.workspaceId,
            subjectType: "report",
            subjectId: report.id,
            body: offer.body,
            payload: offer.payload,
          });
          assistantPosted = true;
        }
      }
    }

    // Member first submit/share → Leader personal key-point extraction (LLM).
    if (
      report.kind === "member" &&
      input.status &&
      (input.status === "submitted" || input.status === "shared") &&
      report.status !== "submitted" &&
      report.status !== "shared"
    ) {
      try {
        const { startPersonalKeyPointExtraction } =
          await import("./weekly-report-key-points.server");
        await startPersonalKeyPointExtraction(this.db, {
          workspaceId: input.workspaceId,
          memberReportId: report.id,
        });
      } catch {
        // Extraction is best-effort; member submit must still succeed.
      }
    }

    return {
      id: updated.id,
      status: updated.status,
      updatedAt: updated.updatedAt.toISOString(),
      autoSendJustCancelled,
      assistantPosted,
    };
  }

  /**
   * Confirmed assistant body-edit write. Does not ask-to-send; the user still controls send.
   */
  async applyConfirmedReportBody(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    content: ReportContent;
  }) {
    return this.saveReportContent({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.reportId,
      content: input.content,
      askToSend: false,
    });
  }

  /**
   * Side-chat Confirm for a key-point-edit suggestion: writes markdown into
   * `content.keyPointExtraction` without replacing the report body tabs.
   */
  async applyConfirmedKeyPointMarkdown(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    markdown: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const markdown = input.markdown.trim();
    if (!markdown) throw new AppError("INVALID_INPUT");

    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true, content: true, kind: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (
      !canEditWeeklyReportContent({
        viewerUserId: input.userId,
        authorUserId: report.authorId,
      })
    ) {
      throw new AppError("ACCESS_DENIED");
    }

    const {
      writeKeyPointExtraction,
      loadSubmittedTeamKeyPointSources,
      linkifyTeamKeyPointMarkdown,
    } = await import("./weekly-report-key-points.server");
    const { DEFAULT_PERSONAL_KEY_POINT_PROMPT, DEFAULT_TEAM_KEY_POINT_PROMPT } =
      await import("@/features/records/records-content");
    const content = asReportContent(report.content);
    const promptSnapshot =
      content.keyPointExtraction?.promptSnapshot ??
      (report.kind === "template"
        ? DEFAULT_TEAM_KEY_POINT_PROMPT
        : DEFAULT_PERSONAL_KEY_POINT_PROMPT);
    const linkedMarkdown =
      report.kind === "template"
        ? linkifyTeamKeyPointMarkdown(
            markdown,
            await loadSubmittedTeamKeyPointSources(this.db, {
              workspaceId: input.workspaceId,
              overviewReportId: report.id,
            }),
            report.id,
          )
        : markdown;
    const next = await writeKeyPointExtraction(this.db, {
      reportId: report.id,
      content,
      extraction: {
        status: "ready",
        promptSnapshot,
        markdown: linkedMarkdown,
        generatedAt: new Date().toISOString(),
      },
    });
    return { id: report.id, content: next };
  }

  /**
   * Side-chat Ignore for a key-point-edit card: drop the pending draft and
   * restore `ready` with the previously published markdown (unchanged).
   */
  async dismissKeyPointConfirmDraft(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true, content: true, kind: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (
      !canEditWeeklyReportContent({
        viewerUserId: input.userId,
        authorUserId: report.authorId,
      })
    ) {
      throw new AppError("ACCESS_DENIED");
    }

    const content = asReportContent(report.content);
    const existing = content.keyPointExtraction;
    if (!existing || existing.status !== "awaiting_confirm") {
      return { id: report.id, content };
    }

    const { writeKeyPointExtraction } = await import("./weekly-report-key-points.server");
    const { DEFAULT_PERSONAL_KEY_POINT_PROMPT, DEFAULT_TEAM_KEY_POINT_PROMPT } =
      await import("@/features/records/records-content");
    const promptSnapshot =
      existing.promptSnapshot ||
      (report.kind === "template"
        ? DEFAULT_TEAM_KEY_POINT_PROMPT
        : DEFAULT_PERSONAL_KEY_POINT_PROMPT);
    const next = await writeKeyPointExtraction(this.db, {
      reportId: report.id,
      content,
      extraction: {
        status: existing.markdown ? "ready" : "failed",
        promptSnapshot,
        ...(existing.markdown ? { markdown: existing.markdown } : {}),
        ...(existing.markdown ? {} : { error: "dismissed_without_published_draft" }),
        ...(existing.generatedAt ? { generatedAt: existing.generatedAt } : {}),
      },
    });
    return { id: report.id, content: next };
  }

  async listTemplates(input: { workspaceId: string; userId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const templates = await this.db.weeklyReportTemplate.findMany({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      include: {
        recipients: {
          include: { user: { select: { id: true, username: true, displayName: true } } },
        },
      },
    });
    return templates.map((template) => ({
      id: template.id,
      name: template.name,
      frequency: template.frequency,
      sendTime: template.sendTime,
      sendWeekday: template.sendWeekday,
      dimensions: asStringArray(template.dimensions),
      mainTitles: asStringArray(template.mainTitles),
      sections: parseTemplateSections(template.dimensions),
      allMembers: template.allMembers,
      active: template.applied,
      scheduleEnabled: template.scheduleEnabled,
      updatedAt: template.updatedAt.toISOString(),
      recipients: template.recipients.map((row) => ({
        userId: row.user.id,
        username: row.user.username,
        displayName: row.user.displayName ?? row.user.username,
      })),
    }));
  }

  /**
   * Leader-owned team/personal key-point prompts (stored on a live format document).
   * Uses the newest applied settings stream, else the newest owned settings row.
   */
  async loadKeyPointPrompts(input: { workspaceId: string; userId: string }) {
    const { emptyKeyPointPrompts } = await import("@/features/records/records-content");
    const format = await this.resolvePromptFormatDoc(input);
    if (!format) return emptyKeyPointPrompts();
    return asReportContent(format.content).keyPointPrompts ?? emptyKeyPointPrompts();
  }

  async saveKeyPointPrompts(input: {
    workspaceId: string;
    userId: string;
    slot: "team" | "personal";
    text: string;
  }) {
    const { emptyKeyPointPrompts, withKeyPointPrompts } =
      await import("@/features/records/records-content");
    const { mergeKeyPointPromptSlot } = await import("./weekly-report-key-points.server");
    await requireMembership(this.db, input.workspaceId, input.userId);
    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      select: { id: true, name: true, dimensions: true },
    });
    if (!settings) throw new AppError("NOT_FOUND");
    const format = await this.ensureFormatForSettings({
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: settings.id,
      settingsName: settings.name,
      sections: parseTemplateSections(settings.dimensions),
    });
    const row = await this.db.weeklyReport.findFirst({
      where: { id: format.id },
      select: { content: true },
    });
    if (!row) throw new AppError("NOT_FOUND");
    const content = asReportContent(row.content);
    const current = content.keyPointPrompts ?? emptyKeyPointPrompts();
    // Preserve the caller's text exactly (including empty / trailing newlines).
    const nextPrompts = mergeKeyPointPromptSlot(current, input.slot, input.text);
    const next = withKeyPointPrompts(content, nextPrompts);
    const updated = await this.db.weeklyReport.update({
      where: { id: format.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
      select: { content: true },
    });
    return asReportContent(updated.content).keyPointPrompts ?? nextPrompts;
  }

  async deleteKeyPointPromptHistory(input: {
    workspaceId: string;
    userId: string;
    slot: "team" | "personal";
    historyIndex: number;
  }) {
    const { emptyKeyPointPrompts, removeKeyPointPromptHistoryEntry, withKeyPointPrompts } =
      await import("@/features/records/records-content");
    await requireMembership(this.db, input.workspaceId, input.userId);
    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      select: { id: true, name: true, dimensions: true },
    });
    if (!settings) throw new AppError("NOT_FOUND");
    const format = await this.ensureFormatForSettings({
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: settings.id,
      settingsName: settings.name,
      sections: parseTemplateSections(settings.dimensions),
    });
    const row = await this.db.weeklyReport.findFirst({
      where: { id: format.id },
      select: { content: true },
    });
    if (!row) throw new AppError("NOT_FOUND");
    const content = asReportContent(row.content);
    const current = content.keyPointPrompts ?? emptyKeyPointPrompts();
    const nextPrompts = {
      ...current,
      [input.slot]: removeKeyPointPromptHistoryEntry(current[input.slot], input.historyIndex),
    };
    await this.db.weeklyReport.update({
      where: { id: format.id },
      data: {
        content: withKeyPointPrompts(content, nextPrompts) as unknown as Prisma.InputJsonValue,
      },
    });
    return nextPrompts;
  }

  /** Leader-only: force a new personal key-point extraction run for a member report. */
  async restartPersonalKeyPointExtraction(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
      },
      select: {
        id: true,
        status: true,
        sourceTemplate: { select: { authorId: true } },
      },
    });
    if (!report?.sourceTemplate) throw new AppError("NOT_FOUND");
    if (report.sourceTemplate.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    if (report.status !== "submitted" && report.status !== "shared") {
      throw new AppError("INVALID_INPUT");
    }
    const { startPersonalKeyPointExtraction } = await import("./weekly-report-key-points.server");
    return startPersonalKeyPointExtraction(this.db, {
      workspaceId: input.workspaceId,
      memberReportId: report.id,
      force: true,
    });
  }

  /** Leader-only: start or re-run team key-point extraction for an overview week parent. */
  async startTeamKeyPointExtraction(input: {
    workspaceId: string;
    userId: string;
    overviewReportId: string;
    force?: boolean;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const overview = await this.db.weeklyReport.findFirst({
      where: {
        id: input.overviewReportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true },
    });
    if (!overview) throw new AppError("NOT_FOUND");
    const assignmentCount = await this.db.weeklyReport.count({
      where: {
        workspaceId: input.workspaceId,
        sourceTemplateId: overview.id,
        kind: "member",
      },
    });
    if (assignmentCount === 0) throw new AppError("NOT_FOUND");
    const { startTeamKeyPointExtraction } = await import("./weekly-report-key-points.server");
    return startTeamKeyPointExtraction(this.db, {
      workspaceId: input.workspaceId,
      overviewReportId: overview.id,
      force: input.force ?? true,
    });
  }

  /**
   * Overview side chat「重新整理」: post the User turn, then start team extraction
   * in side-chat-confirm mode so Agent submit yields an Insert suggestion.
   */
  async startTeamKeyPointExtractionFromSideChat(input: {
    workspaceId: string;
    userId: string;
    overviewReportId: string;
    sessionId: string;
    body: string;
    requestId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const overview = await this.db.weeklyReport.findFirst({
      where: {
        id: input.overviewReportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true },
    });
    if (!overview) throw new AppError("NOT_FOUND");

    const { openWeeklyReportAssistantChat } = await import("./weekly-report-assistant-chat.server");
    const chat = openWeeklyReportAssistantChat(this.db);
    await chat.postRequest({
      workspaceId: input.workspaceId,
      userId: input.userId,
      requestId: input.requestId,
      subjectType: "report",
      subjectId: overview.id,
      sessionId: input.sessionId,
      body: input.body,
    });

    const { startTeamKeyPointExtraction } = await import("./weekly-report-key-points.server");
    return startTeamKeyPointExtraction(this.db, {
      workspaceId: input.workspaceId,
      overviewReportId: overview.id,
      force: true,
      delivery: "side-chat-confirm",
      confirmSessionId: input.sessionId,
    });
  }

  private async resolvePromptFormatDoc(input: { workspaceId: string; userId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      select: { id: true, name: true, dimensions: true },
    });
    if (!settings) return null;
    const linked = await this.ensureFormatForSettings({
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: settings.id,
      settingsName: settings.name,
      sections: parseTemplateSections(settings.dimensions),
    });
    return this.db.weeklyReport.findFirst({
      where: { id: linked.id },
      select: { id: true, content: true },
    });
  }

  /** Toggle whether this send-settings row is an active send stream (multiple allowed).
   * Product「是否启用」keeps `applied` and `scheduleEnabled` in lockstep (WR-33). */
  async applyTemplate(input: { workspaceId: string; userId: string; templateId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const template = await this.db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      select: { id: true, name: true, applied: true, dimensions: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    if (template.applied) {
      await this.db.weeklyReportTemplate.update({
        where: { id: template.id },
        data: { applied: false, scheduleEnabled: false },
      });
      return { id: template.id, active: false as const };
    }
    await this.db.weeklyReportTemplate.update({
      where: { id: template.id },
      data: { applied: true, scheduleEnabled: true },
    });
    await this.ensureFormatForSettings({
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: template.id,
      settingsName: template.name,
      sections: parseTemplateSections(template.dimensions),
      alignContent: true,
    });
    return { id: template.id, active: true as const };
  }

  async setTemplateScheduleEnabled(input: {
    workspaceId: string;
    userId: string;
    templateId: string;
    scheduleEnabled: boolean;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const template = await this.db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      select: { id: true, name: true, applied: true, dimensions: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    await this.db.weeklyReportTemplate.update({
      where: { id: template.id },
      data: { scheduleEnabled: input.scheduleEnabled, applied: input.scheduleEnabled },
    });
    if (input.scheduleEnabled) {
      await this.ensureFormatForSettings({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: template.id,
        settingsName: template.name,
        sections: parseTemplateSections(template.dimensions),
        alignContent: true,
      });
    }
    return {
      id: template.id,
      scheduleEnabled: input.scheduleEnabled,
      active: input.scheduleEnabled,
    };
  }

  /** Rejects a malformed template or recipients outside the Workspace; returns the parsed parts. */
  private async validateTemplateInput(input: TemplateInput & { workspaceId: string }) {
    if (!isValidTemplateName(input.name)) throw new AppError("INVALID_INPUT");
    if (input.sendWeekday < 1 || input.sendWeekday > 7) throw new AppError("INVALID_INPUT");
    if (!isHourlySendTime(input.sendTime)) throw new AppError("INVALID_INPUT");
    if (!input.allMembers && input.recipientUserIds.length > 0) {
      const members = await this.db.workspaceMembership.count({
        where: {
          workspaceId: input.workspaceId,
          userId: { in: input.recipientUserIds },
        },
      });
      if (members !== input.recipientUserIds.length) throw new AppError("INVALID_INPUT");
    }
    return { sections: parseTemplateSections(input.sections), enabled: input.scheduleEnabled };
  }

  async createTemplate(input: TemplateInput & { workspaceId: string; userId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const { sections, enabled } = await this.validateTemplateInput(input);
    const created = await this.db.weeklyReportTemplate.create({
      data: {
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        ...templateWriteData(input, sections),
      },
    });
    if (enabled) {
      await this.ensureFormatForSettings({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: created.id,
        settingsName: input.name.trim(),
        sections,
        alignContent: true,
      });
    }
    return { id: created.id };
  }

  async updateTemplate(
    input: TemplateInput & { workspaceId: string; userId: string; templateId: string },
  ) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const template = await this.db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      select: { id: true, applied: true, name: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    const { sections, enabled } = await this.validateTemplateInput(input);
    await this.db.$transaction(async (tx) => {
      await tx.weeklyReportTemplateRecipient.deleteMany({ where: { templateId: template.id } });
      await tx.weeklyReportTemplate.update({
        where: { id: template.id },
        data: templateWriteData(input, sections),
      });
    });
    if (enabled) {
      await this.ensureFormatForSettings({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: template.id,
        settingsName: input.name.trim(),
        sections,
        alignContent: true,
      });
    }
    return { id: template.id };
  }

  async deleteTemplate(input: { workspaceId: string; userId: string; templateId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const template = await this.db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      select: { id: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    await this.db.weeklyReportTemplate.delete({ where: { id: template.id } });
    return { ok: true as const };
  }

  async loadStats(input: { workspaceId: string; userId: string; year: number; month: number }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const members = await this.db.workspaceMembership.findMany({
      where: { workspaceId: input.workspaceId },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarObjectKey: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const monthWeekSet = [...isoWeeksTouchingMonth(input.year, input.month)];
    const cycles =
      monthWeekSet.length === 0
        ? []
        : await this.db.weeklyReportCycle.findMany({
            where: {
              workspaceId: input.workspaceId,
              OR: monthWeekSet.map(({ year, week }) => ({ year, week })),
            },
            include: {
              reports: {
                where: { kind: "member" },
                select: { authorId: true, status: true },
              },
            },
            orderBy: [{ year: "asc" }, { week: "asc" }],
          });
    const weeks = [...new Set(cycles.map((cycle) => cycle.week))].sort((a, b) => a - b);
    return {
      year: input.year,
      month: input.month,
      weeks,
      members: members.map((member) => {
        const byWeek = new Map(
          cycles.map((cycle) => {
            const report = cycle.reports.find((row) => row.authorId === member.userId);
            const submitted =
              report?.status === "submitted" || report?.status === "shared" ? true : false;
            return [cycle.week, submitted] as const;
          }),
        );
        const submittedCount = [...byWeek.values()].filter(Boolean).length;
        return {
          userId: member.userId,
          username: member.user.username,
          displayName: member.user.displayName ?? member.user.username,
          avatarUrl: workspaceUserAvatarUrl(
            input.workspaceId,
            member.userId,
            member.user.avatarObjectKey,
          ),
          submitted: submittedCount,
          unsubmitted: Math.max(0, weeks.length - submittedCount),
          weeks: Object.fromEntries(byWeek),
        };
      }),
    };
  }

  private async writeAssistantComment(input: {
    workspaceId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    payload?: RecordAssistantPayload;
    assistantSessionId?: string | null;
  }) {
    return this.db.recordComment.create({
      data: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        authorType: "assistant",
        authorUserId: null,
        body: input.body,
        assistantSessionId: input.assistantSessionId ?? null,
        ...(input.payload ? { payload: input.payload as unknown as Prisma.InputJsonValue } : {}),
        reportId: input.subjectType === "report" ? input.subjectId : null,
        cycleId: input.subjectType === "cycle" ? input.subjectId : null,
      },
    });
  }

  /** Platform-owned assistant bubble for collect progress / packs (ADR 0032). */
  async postAssistantCollectComment(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    payload?: RecordAssistantPayload;
    assistantSessionId?: string | null;
  }) {
    const { resolveLatestChatSessionId } =
      await import("./weekly-report-assistant-chat-session.server");
    const assistantSessionId =
      input.assistantSessionId ??
      (await resolveLatestChatSessionId(this.db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      }));
    await this.writeAssistantComment({ ...input, assistantSessionId });
    return this.listComments({ ...input, assistantSessionId });
  }

  async ensureAssistantIntro(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    surface: "format" | "member-leader" | "member-assignee" | "plain";
    formatCopy?: "preview" | "cancelled" | "ready";
    assistantSessionId: string;
    now?: Date;
  }) {
    const existing = await this.listComments(input);
    if (input.surface === "plain" || input.surface === "member-leader") {
      return existing;
    }

    if (input.surface === "format" && input.subjectType === "report") {
      return this.ensureFormatSendOfferIntro({ ...input, existing });
    }

    if (existing.length > 0) return existing;

    if (input.surface === "member-assignee" && input.subjectType === "report") {
      const report = await this.db.weeklyReport.findFirst({
        where: {
          id: input.subjectId,
          workspaceId: input.workspaceId,
          kind: "member",
          authorId: input.userId,
        },
        select: {
          cycle: { select: { year: true, week: true } },
          author: { select: { displayName: true, username: true } },
        },
      });
      if (report) {
        const displayName = report.author.displayName ?? report.author.username;
        await this.writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: `hi，${displayName}，${report.cycle.year} W${report.cycle.week}的工作周报模板已收到，是否需要我来帮你直接生成？`,
          payload: { kind: "offer-help-generate" },
        });
      }
    }

    return this.listComments(input);
  }

  /**
   * When the live format enters a sendable window, post the T2 offer-send card
   * once per session. Outside the window, keep a short ready/cancelled tip if
   * the thread is still empty.
   */
  private async ensureFormatSendOfferIntro(input: {
    workspaceId: string;
    userId: string;
    subjectId: string;
    assistantSessionId: string;
    formatCopy?: "preview" | "cancelled" | "ready";
    existing: Awaited<ReturnType<RecordCatalog["listComments"]>>;
    now?: Date;
  }) {
    const hasOfferSend = input.existing.some(
      (row) => parseRecordAssistantPayload(row.payload)?.kind === "offer-send",
    );
    if (hasOfferSend) return input.existing;

    const offer = await this.buildFormatOfferSend({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.subjectId,
      now: input.now,
    });
    if (offer) {
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.subjectId,
        assistantSessionId: input.assistantSessionId,
        body: offer.body,
        payload: offer.payload,
      });
      return this.listComments({
        workspaceId: input.workspaceId,
        userId: input.userId,
        subjectType: "report",
        subjectId: input.subjectId,
        assistantSessionId: input.assistantSessionId,
      });
    }

    if (input.existing.length > 0) return input.existing;

    const body =
      input.formatCopy === "cancelled"
        ? "已取消本周自动发送。保存后请手动发送周报模板。"
        : "需要把周报模板发给成员时，保存后点击发送即可。";
    await this.writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: input.subjectId,
      assistantSessionId: input.assistantSessionId,
      body,
    });
    return this.listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.subjectId,
      assistantSessionId: input.assistantSessionId,
    });
  }

  private async buildFormatOfferSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }): Promise<{
    body: string;
    payload: Extract<RecordAssistantPayload, { kind: "offer-send" }>;
  } | null> {
    const sendState = await this.loadFormatSendState(input);
    if (!sendState.canSend) return null;

    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: {
        id: true,
        settingsId: true,
        updatedAt: true,
        cycle: { select: { year: true, week: true } },
        author: { select: { displayName: true, username: true } },
      },
    });
    if (!report?.settingsId) return null;

    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: {
        id: report.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
      },
      select: {
        allMembers: true,
        recipients: {
          select: {
            user: {
              select: { id: true, displayName: true, username: true, avatarObjectKey: true },
            },
          },
        },
      },
    });
    if (!settings) return null;

    let people: Array<{
      id: string;
      displayName: string | null;
      username: string;
      avatarObjectKey: string | null;
    }>;
    if (settings.allMembers) {
      const memberships = await this.db.workspaceMembership.findMany({
        where: { workspaceId: input.workspaceId },
        select: {
          user: {
            select: { id: true, displayName: true, username: true, avatarObjectKey: true },
          },
        },
        take: 40,
      });
      people = memberships.map((row) => row.user);
    } else {
      people = settings.recipients.map((row) => row.user);
    }

    const recipients = people
      .filter((user) => user.id !== input.userId)
      .map((user) => ({
        displayName: user.displayName ?? user.username,
        avatarUrl: workspaceUserAvatarUrl(input.workspaceId, user.id, user.avatarObjectKey),
      }));
    const year = report.cycle.year;
    const week = report.cycle.week;
    const displayName = report.author.displayName ?? report.author.username;
    return {
      body: `hi，${displayName}，${year} W${week}的工作周报模板已生成，请确认是否发送。`,
      payload: {
        kind: "offer-send",
        year,
        week,
        weekTitle: formatOfferSendWeekTitle(year, week),
        updatedAt: report.updatedAt.toISOString(),
        recipients: recipients.slice(0, 8),
        recipientTotal: recipients.length,
      },
    };
  }

  /** Leader cancels this week's template send entirely（取消本周周报）. */
  async dismissWeeklyFormatSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId?: string | null;
    now?: Date;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: {
        id: true,
        content: true,
        settingsId: true,
        cycle: { select: { year: true, week: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report || report.submissions.length > 0) throw new AppError("NOT_FOUND");
    const sendState = await this.loadFormatSendState({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: report.id,
      now: input.now,
    });
    if (!sendState.canSend && !sendState.schedule) throw new AppError("INVALID_INPUT");

    const content = withWeekSendDismissed(
      asReportContent(report.content),
      report.cycle.year,
      report.cycle.week,
    );
    await this.db.weeklyReport.update({
      where: { id: report.id },
      data: { content: content as unknown as Prisma.InputJsonValue },
    });
    await this.writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
      body: "已取消本周周报。",
    });
    return this.listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
    });
  }

  /** Assignee accepts 「需要」— posts the user turn and the E2 clarifying reply. */
  async acceptMemberGenerateHelp(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: { id: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    return this.postSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
      body: "需要",
    });
  }

  async postSideChat(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    assistantSessionId: string;
  }) {
    await this.addUserComment(input);
    if (looksLikeSideChatGreeting(input.body)) {
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        assistantSessionId: input.assistantSessionId,
        body: "你好！我是周报助手。需要我整理要点、改文案，还是别的周报相关帮助？",
      });
    } else if (input.subjectType === "report" && looksLikeMemberGenerateOfferAccept(input.body)) {
      const assignment = await this.db.weeklyReport.findFirst({
        where: {
          id: input.subjectId,
          workspaceId: input.workspaceId,
          kind: "member",
          authorId: input.userId,
        },
        select: {
          id: true,
          cycle: { select: { year: true, week: true } },
        },
      });
      if (assignment) {
        await this.writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: "好的，请确认数据采集的相关设置，以帮助你生成更全面的周报。",
          payload: {
            kind: "collect-plan",
            reportId: assignment.id,
            year: assignment.cycle.year,
            week: assignment.cycle.week,
          },
        });
      }
    } else if (input.subjectType === "report" && looksLikeCollectAgainRequest(input.body)) {
      const assignment = await this.loadMemberAssignmentForSideChat(input);
      if (assignment) {
        await this.writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: "要重新采集一遍工作证据吗？确认后会打开采集设置卡。",
          payload: {
            kind: "confirm-intent",
            intent: "collect-again",
            reportId: assignment.id,
            year: assignment.year,
            week: assignment.week,
            userGuidance: input.body.trim(),
          },
        });
      }
    } else if (
      input.subjectType === "report" &&
      looksLikeSynthesizeWeeklyReportRequest(input.body)
    ) {
      const assignment = await this.loadMemberAssignmentForSideChat(input);
      if (assignment) {
        await this.writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: "要根据已有采集包整理一份周报草稿吗？",
          payload: {
            kind: "confirm-intent",
            intent: "synthesize",
            reportId: assignment.id,
            year: assignment.year,
            week: assignment.week,
            userGuidance: input.body.trim(),
          },
        });
      }
    }
    return this.listComments(input);
  }

  /**
   * Applies member-assignee platform rules only when the subject is that user's
   * member report. Overview / other subjects return null so the caller can fall
   * through to the Agent DM (e.g. 「重新整理」 for team key points).
   */
  async postMemberReportRuleSideChatIfApplicable(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    assistantSessionId: string;
  }) {
    if (input.subjectType !== "report") return null;
    if (!looksLikeMemberReportRuleIntent(input.body)) return null;
    const assignment = await this.loadMemberAssignmentForSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectId: input.subjectId,
    });
    if (!assignment) return null;
    return this.postSideChat(input);
  }

  private async loadMemberAssignmentForSideChat(input: {
    workspaceId: string;
    userId: string;
    subjectId: string;
  }) {
    const assignment = await this.db.weeklyReport.findFirst({
      where: {
        id: input.subjectId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: {
        id: true,
        cycle: { select: { year: true, week: true } },
      },
    });
    if (!assignment) return null;
    return {
      id: assignment.id,
      year: assignment.cycle.year,
      week: assignment.cycle.week,
    };
  }

  /** User confirms a regex-matched side-chat intent (collect-again / synthesize). */
  async confirmMemberReportIntent(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId: string;
    intent: "collect-again" | "synthesize";
    userGuidance?: string | null;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const assignment = await this.loadMemberAssignmentForSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectId: input.reportId,
    });
    if (!assignment) throw new AppError("NOT_FOUND");

    await this.addUserComment({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      body: "确认",
      assistantSessionId: input.assistantSessionId,
    });

    if (input.intent === "collect-again") {
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        body: "好的，请确认采集设置后提交。",
        payload: {
          kind: "collect-plan",
          reportId: assignment.id,
          year: assignment.year,
          week: assignment.week,
        },
      });
      return this.listComments({
        workspaceId: input.workspaceId,
        userId: input.userId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
      });
    }

    const guidance =
      input.userGuidance?.trim() ||
      (await this.latestConfirmIntentOriginalText({
        workspaceId: input.workspaceId,
        reportId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        intent: "synthesize",
      }));

    const { requestWeeklyReportSynthesis } =
      await import("./weekly-report-collect-orchestrate.server");
    const synthesis = await requestWeeklyReportSynthesis(this.db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: assignment.id,
      sessionId: input.assistantSessionId,
      userGuidance: guidance,
    });
    if (synthesis.ok) {
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        body: "好的，正在根据已有采集包整理周报草稿，请稍候确认。",
      });
    } else {
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        body: "目前还没有可用的采集包。请先确认采集设置；采集完成后再整理。",
        payload: {
          kind: "collect-plan",
          reportId: assignment.id,
          year: assignment.year,
          week: assignment.week,
        },
      });
    }
    return this.listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      assistantSessionId: input.assistantSessionId,
    });
  }

  /**
   * Recover the original user utterance for a confirm-intent card.
   * Prefer stored `userGuidance`; otherwise the preceding user comment.
   */
  private async latestConfirmIntentOriginalText(input: {
    workspaceId: string;
    reportId: string;
    assistantSessionId: string;
    intent?: "collect-again" | "synthesize";
  }): Promise<string | null> {
    const rows = await this.db.recordComment.findMany({
      where: {
        workspaceId: input.workspaceId,
        reportId: input.reportId,
        assistantSessionId: input.assistantSessionId,
      },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { authorType: true, body: true, payload: true },
    });
    let seekingPrecedingUser = false;
    for (const row of rows) {
      if (!seekingPrecedingUser) {
        if (row.authorType !== "assistant") continue;
        const payload = parseRecordAssistantPayload(row.payload);
        if (payload?.kind !== "confirm-intent") continue;
        if (input.intent && payload.intent !== input.intent) continue;
        const guided = payload.userGuidance?.trim();
        if (guided) return guided;
        seekingPrecedingUser = true;
        continue;
      }
      if (row.authorType !== "user") continue;
      const body = row.body.trim();
      if (!body || body === "确认" || body === "不是") continue;
      return body;
    }
    return null;
  }

  /**
   * User declines a regex-matched side-chat intent.
   * Recover the original utterance so the caller can forward it to the Agent
   * (bypass rule path) instead of ending the turn.
   */
  async declineMemberReportIntent(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const assignment = await this.loadMemberAssignmentForSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectId: input.reportId,
    });
    if (!assignment) throw new AppError("NOT_FOUND");

    const originalUserText = await this.latestConfirmIntentOriginalText({
      workspaceId: input.workspaceId,
      reportId: input.reportId,
      assistantSessionId: input.assistantSessionId,
    });

    await this.addUserComment({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      body: "不是",
      assistantSessionId: input.assistantSessionId,
    });
    await this.writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: input.reportId,
      assistantSessionId: input.assistantSessionId,
      body: originalUserText
        ? "好的，我按你刚才的问题继续回答。"
        : "好的。需要采集或整理周报时再说一声。",
      payload: { kind: "intent-declined" },
    });
    const comments = await this.listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      assistantSessionId: input.assistantSessionId,
    });
    return { comments, originalUserText };
  }

  async listComments(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    assistantSessionId?: string | null;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const where =
      input.subjectType === "report" ? { reportId: input.subjectId } : { cycleId: input.subjectId };
    const rows = await this.db.recordComment.findMany({
      where: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        ...where,
        ...(input.assistantSessionId ? { assistantSessionId: input.assistantSessionId } : {}),
      },
      orderBy: { createdAt: "asc" },
      include: {
        authorUser: {
          select: { id: true, username: true, displayName: true, avatarObjectKey: true },
        },
      },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      authorType: row.authorType,
      body: row.body,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
      author: row.authorUser
        ? {
            userId: row.authorUser.id,
            username: row.authorUser.username,
            displayName: row.authorUser.displayName ?? row.authorUser.username,
            avatarUrl: workspaceUserAvatarUrl(
              input.workspaceId,
              row.authorUser.id,
              row.authorUser.avatarObjectKey,
            ),
          }
        : null,
    }));
  }

  async addUserComment(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    assistantSessionId?: string | null;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const body = input.body.trim();
    if (!body) throw new AppError("INVALID_INPUT");
    const data = {
      workspaceId: input.workspaceId,
      subjectType: input.subjectType,
      authorType: "user",
      authorUserId: input.userId,
      body,
      assistantSessionId: input.assistantSessionId ?? null,
      reportId: input.subjectType === "report" ? input.subjectId : null,
      cycleId: input.subjectType === "cycle" ? input.subjectId : null,
    };
    const created = await this.db.recordComment.create({ data });
    return { id: created.id, createdAt: created.createdAt.toISOString() };
  }
}

/** ISO (year, week) pairs that intersect the given calendar month. */
function isoWeeksTouchingMonth(year: number, month: number): Array<{ year: number; week: number }> {
  const result: Array<{ year: number; week: number }> = [];
  const days = new Date(year, month, 0).getDate();
  const seen = new Set<string>();
  for (let day = 1; day <= days; day += 1) {
    const iso = currentIsoWeek(new Date(year, month - 1, day));
    const key = `${iso.year}-${iso.week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(iso);
  }
  return result;
}

export function recordCatalog(db: Db) {
  return new RecordCatalog(db);
}
