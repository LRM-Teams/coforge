import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import {
  currentIsoWeek,
  emptyReportContent,
  generatingHighlightContent,
  highlightTitle,
  isAssignmentUnread,
  isAutoSendCancelled,
  isHighlightGenerating,
  isValidTemplateName,
  isHourlySendTime,
  memberReportTitle,
  memberWeekTitle,
  normalizeHighlightContent,
  normalizeReportContent,
  reportTabsEqual,
  applyHighlightPromptText,
  withAssignmentUnread,
  withAutoSendCancelled,
  withHighlightPrompt,
  type HighlightContent,
  type HighlightPromptState,
  type ReportContent,
} from "../../features/records/records-content";
import {
  extractWeeklyHighlightContent,
  looksLikeGenerateHighlightsRequest,
  type HighlightMemberCandidate,
  type RecordAssistantPayload,
} from "../../features/records/weekly-highlight-extract";
import {
  canSendWeeklyAssignmentsNow,
  currentWeekTemplateTitle,
  isWeeklySendArmed,
  splitWeeklyTemplateRoles,
} from "../../features/records/weekly-send-window";
import {
  alignReportContentToSections,
  parseTemplateSections,
  reportContentFromSections,
  sectionsFromReportContent,
  type TemplateOutlineSection,
} from "../../features/records/template-outline-sections";
import { isVisibleTemplateSubmission } from "./template-submission-visibility";
import { canEditWeeklyReportContent } from "./weekly-report-editability";
import { recipientUserIdsForSend } from "./weekly-report-send-recipients";
import type { WeeklyAssignmentDelivery } from "./weekly-assignment-channel-delivery.server";
import { isWeeklyScheduleDue, zonedCalendarDate } from "./weekly-report-schedule-due";

type Db = PrismaClient;

function asReportContent(value: unknown): ReportContent {
  return normalizeReportContent(value);
}

function asHighlightContent(value: unknown): HighlightContent {
  return normalizeHighlightContent(value);
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
  constructor(
    private readonly db: Db,
    private readonly delivery?: WeeklyAssignmentDelivery,
  ) {}

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
    const schedule = {
      sendWeekday: settings.sendWeekday,
      sendTime: settings.sendTime,
      scheduleEnabled: settings.scheduleEnabled,
      autoSendCancelled,
      alreadySent,
    };
    return {
      canSend: canSendWeeklyAssignmentsNow({
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

  async loadCatalog(input: { workspaceId: string; userId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const [cycles, favorites, notes, me] = await Promise.all([
      this.db.weeklyReportCycle.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ year: "desc" }, { week: "desc" }],
        include: {
          highlight: { select: { id: true, title: true, completedAt: true, content: true } },
          reports: {
            include: {
              author: { select: { id: true, username: true, displayName: true } },
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
              author: { select: { id: true, username: true, displayName: true } },
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
        select: { id: true, username: true, displayName: true },
      }),
    ]);

    const highlights = cycles
      .filter((cycle) => cycle.highlight)
      .map((cycle) => ({
        id: cycle.highlight!.id,
        cycleId: cycle.id,
        year: cycle.year,
        week: cycle.week,
        title: cycle.highlight!.title,
        completedAt: cycle.highlight!.completedAt?.toISOString() ?? null,
        generating: isHighlightGenerating(asHighlightContent(cycle.highlight!.content)),
      }))
      .sort((left, right) =>
        left.year !== right.year ? right.year - left.year : right.week - left.week,
      );

    const templateEntries = cycles
      .flatMap((cycle) =>
        cycle.reports
          .filter((report) => report.kind === "template" && report.authorId === input.userId)
          .map((report) => ({ cycle, report })),
      )
      .sort((left, right) => right.report.createdAt.getTime() - left.report.createdAt.getTime());

    const now = new Date();
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
        submissions: Array<{
          id: string;
          title: string;
          status: string;
          submittedAt: string | null;
          sourceTemplateId: string | null;
          author: { userId: string; username: string; displayName: string };
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
      favorites: favorites.map((row) => ({
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
        },
      })),
      highlights,
      myReports: cycles.flatMap((cycle) =>
        cycle.reports
          .filter((report) => report.kind === "member" && report.authorId === input.userId)
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

  /** Records rail dot: any applied scheduled stream is in the one-hour preview and not cancelled. */
  async loadNavAttention(input: { workspaceId: string; userId: string; now?: Date }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
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
      await this.db.weeklyReport.update({
        where: { id: linked.id },
        data: { title: input.settingsName },
      });
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
    const previous = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: input.settingsId,
      },
      orderBy: { updatedAt: "desc" },
      select: { content: true },
    });
    const previousPrompt = asReportContent(previous?.content).highlightPrompt;
    let content =
      input.sections && input.sections.length > 0
        ? reportContentFromSections(input.sections)
        : emptyReportContent();
    if (previousPrompt) {
      content = withHighlightPrompt(content, previousPrompt);
    }
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
    const title = memberWeekTitle(year, week);
    const existing = await this.db.weeklyReportCycle.findUnique({
      where: { workspaceId_year_week: { workspaceId: input.workspaceId, year, week } },
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
        year,
        week,
        title,
        createdById: input.userId,
      },
      select: { id: true, year: true, week: true, title: true },
    });
    return { id: cycle.id, year: cycle.year, week: cycle.week, title: cycle.title, created: true };
  }

  /** Create a highlight for the current ISO week only — does not create reports. */
  async createHighlight(input: { workspaceId: string; userId: string; now?: Date }) {
    const cycle = await this.ensureCurrentCycle(input);
    const existing = await this.db.weeklyReportHighlight.findUnique({
      where: { cycleId: cycle.id },
      select: { id: true, title: true },
    });
    if (existing) {
      return {
        id: existing.id,
        cycleId: cycle.id,
        title: existing.title,
        year: cycle.year,
        week: cycle.week,
        created: false,
      };
    }
    const highlight = await this.db.weeklyReportHighlight.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        title: highlightTitle(cycle.year, cycle.week),
        content: generatingHighlightContent() as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, title: true },
    });
    return {
      id: highlight.id,
      cycleId: cycle.id,
      title: highlight.title,
      year: cycle.year,
      week: cycle.week,
      created: true,
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

    if (this.delivery) {
      try {
        const sender = await this.db.user.findUnique({
          where: { id: input.userId },
          select: { displayName: true, username: true },
        });
        await this.delivery.notifyChannel({
          workspaceId: input.workspaceId,
          senderUserId: input.userId,
          parentReportId: parent.id,
          week: cycle.week,
          senderDisplayName: sender?.displayName ?? sender?.username ?? "Leader",
        });
      } catch {
        // Assignments already persisted; channel notice is best-effort only.
      }
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
      select: { id: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
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
    if (!canAccess) throw new AppError("NOT_FOUND");

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

  async loadAssistantContextManifest(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "highlight" | "cycle";
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
          "highlights",
          "favorites",
        ],
        contextVersion: subject.report.updatedAt,
      } as const;
    }

    if (input.subjectType === "highlight") {
      const subject = await this.getSubject({
        workspaceId: input.workspaceId,
        userId: input.userId,
        id: input.subjectId,
      });
      if (subject.type !== "highlight") throw new AppError("NOT_FOUND");
      const sourceReportIds = subject.highlight.content.blocks.flatMap((block) =>
        block.items.flatMap((item) =>
          typeof item === "string" ? [] : item.sources.map((source) => source.reportId),
        ),
      );
      return {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        cycle: subject.highlight.cycle,
        structure: subject.highlight.content.blocks.map((block) => block.heading),
        availableData: ["highlight", "source_reports", "visible_member_reports"],
        sourceReportIds: [...new Set(sourceReportIds)],
        contextVersion: subject.highlight.completedAt ?? subject.highlight.cycle.title,
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
      availableData: ["cycle", "visible_member_reports", "highlights", "submission_status"],
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
        author: { select: { id: true, username: true, displayName: true } },
        cycle: { select: { id: true, year: true, week: true, title: true } },
        sourceTemplate: {
          select: {
            authorId: true,
            author: { select: { id: true, username: true, displayName: true } },
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
        if (!isAuthor && !isTemplateOwner) throw new AppError("NOT_FOUND");
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
                  status: { in: ["submitted", "shared"] },
                  ...(isTemplateAuthor ? {} : { authorId: input.userId }),
                },
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  author: { select: { id: true, username: true, displayName: true } },
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
              author: {
                userId: child.author.id,
                username: child.author.username,
                displayName: child.author.displayName ?? child.author.username,
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
          },
          sharedBy:
            report.kind === "member" && report.sourceTemplate?.author
              ? {
                  userId: report.sourceTemplate.author.id,
                  username: report.sourceTemplate.author.username,
                  displayName:
                    report.sourceTemplate.author.displayName ??
                    report.sourceTemplate.author.username,
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
          highlightPrompt:
            report.kind === "template" && surface === "format"
              ? (content.highlightPrompt ?? { text: "", history: [] })
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

    const highlight = await this.db.weeklyReportHighlight.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
      include: { cycle: { select: { id: true, year: true, week: true, title: true } } },
    });
    if (highlight) {
      return {
        type: "highlight" as const,
        highlight: {
          id: highlight.id,
          title: highlight.title,
          content: asHighlightContent(highlight.content),
          completedAt: highlight.completedAt?.toISOString() ?? null,
          generating: isHighlightGenerating(asHighlightContent(highlight.content)),
          cycle: highlight.cycle,
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

  async saveHighlightPrompt(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    text: string;
    now?: Date;
  }): Promise<{ highlightPrompt: HighlightPromptState }> {
    await requireMembership(this.db, input.workspaceId, input.userId);
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
    if (!report) throw new AppError("NOT_FOUND");
    const stored = asReportContent(report.content);
    const highlightPrompt = applyHighlightPromptText(
      stored.highlightPrompt,
      input.text,
      input.now ?? new Date(),
    );
    const next = withHighlightPrompt(stored, highlightPrompt);
    await this.db.weeklyReport.update({
      where: { id: report.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
    return { highlightPrompt };
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
        settingsId: true,
        content: true,
        cycle: { select: { year: true, week: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
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
    const stored = asReportContent(report.content);
    let content = normalizeReportContent(input.content);
    if (stored.schedule && !content.schedule) {
      content = { ...content, schedule: stored.schedule };
    }
    if (stored.highlightPrompt && !content.highlightPrompt) {
      content = { ...content, highlightPrompt: stored.highlightPrompt };
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
        const canSend = await this.canSendWeeklyAssignments({
          workspaceId: input.workspaceId,
          userId: input.userId,
          reportId: report.id,
          now,
        });
        if (canSend) {
          await this.writeAssistantComment({
            workspaceId: input.workspaceId,
            subjectType: "report",
            subjectId: report.id,
            body: "模板已保存。要现在发送给名单中的成员吗？",
            payload: { kind: "offer-send" },
          });
          assistantPosted = true;
        }
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

  async saveHighlightContent(input: {
    workspaceId: string;
    userId: string;
    highlightId: string;
    content: HighlightContent;
    markCompleted?: boolean;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const highlight = await this.db.weeklyReportHighlight.findFirst({
      where: { id: input.highlightId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!highlight) throw new AppError("NOT_FOUND");
    const updated = await this.db.weeklyReportHighlight.update({
      where: { id: highlight.id },
      data: {
        content: normalizeHighlightContent(input.content) as unknown as Prisma.InputJsonValue,
        ...(input.markCompleted ? { completedAt: new Date() } : {}),
      },
    });
    return {
      id: updated.id,
      completedAt: updated.completedAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt.toISOString(),
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
   * Confirmed assistant highlight write. Upserts the cycle highlight when highlightId is omitted.
   */
  async applyConfirmedHighlight(input: {
    workspaceId: string;
    userId: string;
    cycleId: string;
    highlightId?: string;
    content: HighlightContent;
    markCompleted?: boolean;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const content = normalizeHighlightContent(input.content);
    const cycle = await this.db.weeklyReportCycle.findFirst({
      where: { id: input.cycleId, workspaceId: input.workspaceId },
      select: { id: true, year: true, week: true },
    });
    if (!cycle) throw new AppError("NOT_FOUND");

    if (input.highlightId) {
      const existing = await this.db.weeklyReportHighlight.findFirst({
        where: {
          id: input.highlightId,
          workspaceId: input.workspaceId,
          cycleId: input.cycleId,
        },
        select: { id: true },
      });
      if (!existing) throw new AppError("NOT_FOUND");
      const updated = await this.saveHighlightContent({
        workspaceId: input.workspaceId,
        userId: input.userId,
        highlightId: input.highlightId,
        content,
        markCompleted: input.markCompleted,
      });
      return {
        highlightId: updated.id,
        title: highlightTitle(cycle.year, cycle.week),
        completedAt: updated.completedAt,
        updatedAt: updated.updatedAt,
      };
    }

    const title = highlightTitle(cycle.year, cycle.week);
    const existing = await this.db.weeklyReportHighlight.findUnique({
      where: { cycleId: input.cycleId },
      select: { id: true },
    });
    const now = new Date();
    if (existing) {
      const updated = await this.db.weeklyReportHighlight.update({
        where: { id: existing.id },
        data: {
          title,
          content: content as unknown as Prisma.InputJsonValue,
          ...(input.markCompleted ? { completedAt: now } : {}),
        },
        select: { id: true, completedAt: true, updatedAt: true },
      });
      return {
        highlightId: updated.id,
        title,
        completedAt: updated.completedAt?.toISOString() ?? null,
        updatedAt: updated.updatedAt.toISOString(),
      };
    }

    const created = await this.db.weeklyReportHighlight.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: input.cycleId,
        title,
        content: content as unknown as Prisma.InputJsonValue,
        ...(input.markCompleted ? { completedAt: now } : {}),
      },
      select: { id: true, completedAt: true, updatedAt: true },
    });
    return {
      highlightId: created.id,
      title,
      completedAt: created.completedAt?.toISOString() ?? null,
      updatedAt: created.updatedAt.toISOString(),
    };
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
      include: { user: { select: { id: true, username: true, displayName: true } } },
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
          submitted: submittedCount,
          unsubmitted: Math.max(0, weeks.length - submittedCount),
          weeks: Object.fromEntries(byWeek),
        };
      }),
    };
  }

  private async writeAssistantComment(input: {
    workspaceId: string;
    subjectType: "report" | "highlight" | "cycle";
    subjectId: string;
    body: string;
    payload?: RecordAssistantPayload;
  }) {
    return this.db.recordComment.create({
      data: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        authorType: "assistant",
        authorUserId: null,
        body: input.body,
        ...(input.payload ? { payload: input.payload as unknown as Prisma.InputJsonValue } : {}),
        reportId: input.subjectType === "report" ? input.subjectId : null,
        highlightId: input.subjectType === "highlight" ? input.subjectId : null,
        cycleId: input.subjectType === "cycle" ? input.subjectId : null,
      },
    });
  }

  private async loadHighlightMembers(input: {
    workspaceId: string;
    cycleId: string;
  }): Promise<HighlightMemberCandidate[]> {
    const rows = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        cycleId: input.cycleId,
        kind: "member",
      },
      select: {
        id: true,
        authorId: true,
        status: true,
        author: { select: { displayName: true, username: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => {
      const submitted = row.status === "submitted" || row.status === "shared";
      return {
        userId: row.authorId,
        displayName: row.author.displayName ?? row.author.username,
        submitted,
        reportId: submitted ? row.id : undefined,
      };
    });
  }

  async ensureAssistantIntro(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "highlight" | "cycle";
    subjectId: string;
    surface: "format" | "member-leader" | "highlight" | "plain";
    formatCopy?: "preview" | "cancelled" | "ready";
  }) {
    const existing = await this.listComments(input);
    if (existing.length > 0 || input.surface === "plain") return existing;

    if (input.surface === "format") {
      const body =
        input.formatCopy === "cancelled"
          ? "已取消本周自动发送。保存后请手动发送周报模板。"
          : input.formatCopy === "preview"
            ? "本周模板已进入发送预览。一小时内未编辑将自动发给名单；也可现在发送。"
            : "需要把周报模板发给成员时，保存后点击发送即可。";
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        body,
      });
    } else if (input.surface === "member-leader" && input.subjectType === "report") {
      const report = await this.db.weeklyReport.findFirst({
        where: { id: input.subjectId, workspaceId: input.workspaceId },
        select: { cycleId: true },
      });
      const members = report
        ? await this.loadHighlightMembers({
            workspaceId: input.workspaceId,
            cycleId: report.cycleId,
          })
        : [];
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.subjectId,
        body: "要生成本周周报要点吗？可以选择全部已提交成员，或只选部分成员。",
        payload: { kind: "offer-generate", members },
      });
    } else if (input.surface === "highlight") {
      await this.writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "highlight",
        subjectId: input.subjectId,
        body: "这是本周周报要点。条目下的 @ 可跳到对应成员周报。",
      });
    }

    return this.listComments(input);
  }

  async postSideChat(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "highlight" | "cycle";
    subjectId: string;
    body: string;
  }) {
    await this.addUserComment(input);
    if (input.subjectType === "report" && looksLikeGenerateHighlightsRequest(input.body)) {
      const report = await this.db.weeklyReport.findFirst({
        where: { id: input.subjectId, workspaceId: input.workspaceId },
        select: { cycleId: true },
      });
      const leaderTemplate = report
        ? await this.db.weeklyReport.findFirst({
            where: {
              workspaceId: input.workspaceId,
              cycleId: report.cycleId,
              authorId: input.userId,
              kind: "template",
            },
            select: { id: true },
          })
        : null;
      if (report && leaderTemplate) {
        const members = await this.loadHighlightMembers({
          workspaceId: input.workspaceId,
          cycleId: report.cycleId,
        });
        await this.writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          body: "请选择要纳入要点的成员，然后确认。",
          payload: { kind: "pick-members", members },
        });
      }
    }
    return this.listComments(input);
  }

  async generateWeeklyHighlights(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    memberIds: "all" | string[];
    now?: Date;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const source = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: { id: true, cycleId: true, cycle: { select: { year: true, week: true } } },
    });
    if (!source) throw new AppError("NOT_FOUND");
    const leaderTemplate = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        cycleId: source.cycleId,
        authorId: input.userId,
        kind: "template",
      },
      select: { id: true },
    });
    if (!leaderTemplate) throw new AppError("ACCESS_DENIED");

    const submissions = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        cycleId: source.cycleId,
        kind: "member",
        status: { in: ["submitted", "shared"] },
      },
      select: {
        id: true,
        authorId: true,
        content: true,
        author: { select: { displayName: true, username: true } },
      },
    });
    if (input.memberIds !== "all") {
      const allowed = new Set(submissions.map((row) => row.authorId));
      if (input.memberIds.some((id) => !allowed.has(id))) {
        throw new AppError("INVALID_INPUT");
      }
    }
    const selected =
      input.memberIds === "all"
        ? submissions
        : submissions.filter((row) => input.memberIds.includes(row.authorId));
    if (selected.length === 0) throw new AppError("INVALID_INPUT");

    const extracted = extractWeeklyHighlightContent(
      selected.map((row) => ({
        reportId: row.id,
        userId: row.authorId,
        displayName: row.author.displayName ?? row.author.username,
        content: asReportContent(row.content),
      })),
    );
    const now = input.now ?? new Date();
    const title = highlightTitle(source.cycle.year, source.cycle.week);
    const existing = await this.db.weeklyReportHighlight.findUnique({
      where: { cycleId: source.cycleId },
      select: { id: true, title: true },
    });
    const highlight = existing
      ? existing
      : await this.db.weeklyReportHighlight.create({
          data: {
            workspaceId: input.workspaceId,
            cycleId: source.cycleId,
            title,
            content: generatingHighlightContent() as unknown as Prisma.InputJsonValue,
          },
          select: { id: true, title: true },
        });
    await this.db.weeklyReportHighlight.update({
      where: { id: highlight.id },
      data: {
        title,
        content: extracted as unknown as Prisma.InputJsonValue,
        completedAt: now,
      },
    });
    await this.writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: source.id,
      body: "本周周报要点已生成。",
      payload: { kind: "generated", highlightId: highlight.id },
    });
    await this.writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "highlight",
      subjectId: highlight.id,
      body: "本周周报要点已根据所选成员周报生成。",
      payload: { kind: "generated", highlightId: highlight.id },
    });
    return {
      highlightId: highlight.id,
      title,
      year: source.cycle.year,
      week: source.cycle.week,
    };
  }

  async listComments(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "highlight" | "cycle";
    subjectId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const where =
      input.subjectType === "report"
        ? { reportId: input.subjectId }
        : input.subjectType === "highlight"
          ? { highlightId: input.subjectId }
          : { cycleId: input.subjectId };
    const rows = await this.db.recordComment.findMany({
      where: { workspaceId: input.workspaceId, subjectType: input.subjectType, ...where },
      orderBy: { createdAt: "asc" },
      include: {
        authorUser: { select: { id: true, username: true, displayName: true } },
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
          }
        : null,
    }));
  }

  async addUserComment(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "highlight" | "cycle";
    subjectId: string;
    body: string;
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
      reportId: input.subjectType === "report" ? input.subjectId : null,
      highlightId: input.subjectType === "highlight" ? input.subjectId : null,
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

export function recordCatalog(db: Db, delivery?: WeeklyAssignmentDelivery) {
  return new RecordCatalog(db, delivery);
}
