import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import {
  currentIsoWeek,
  emptyHighlightContent,
  emptyReportContent,
  highlightTitle,
  isValidTemplateName,
  memberWeekTitle,
  normalizeReportContent,
  type HighlightContent,
  type ReportContent,
} from "../../features/records/records-content";

type Db = PrismaClient;

function asReportContent(value: unknown): ReportContent {
  return normalizeReportContent(value);
}

function asHighlightContent(value: unknown): HighlightContent {
  if (value && typeof value === "object" && "blocks" in value) return value as HighlightContent;
  return emptyHighlightContent();
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

export class RecordCatalog {
  constructor(private readonly db: Db) {}

  async loadCatalog(input: { workspaceId: string; userId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const [cycles, favorites, notes, me] = await Promise.all([
      this.db.weeklyReportCycle.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ year: "desc" }, { week: "desc" }],
        include: {
          highlight: { select: { id: true, title: true, completedAt: true } },
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
        where: { workspaceId: input.workspaceId },
        orderBy: { updatedAt: "desc" },
        take: 50,
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
        week: cycle.week,
        title: cycle.highlight!.title,
        completedAt: cycle.highlight!.completedAt?.toISOString() ?? null,
      }));

    const templateEntries = cycles
      .flatMap((cycle) =>
        cycle.reports
          .filter((report) => report.kind === "template")
          .map((report) => ({ cycle, report })),
      )
      .sort((left, right) => right.report.createdAt.getTime() - left.report.createdAt.getTime());
    const latestTemplateId = templateEntries[0]?.report.id;

    const memberTemplates = templateEntries.map(({ cycle, report }) => ({
      id: report.id,
      title: report.title,
      status: report.status,
      year: cycle.year,
      week: cycle.week,
      cycleId: cycle.id,
      latestTemplate: report.id === latestTemplateId,
      submissions: cycle.reports
        .filter(
          (candidate) =>
            candidate.kind === "member" &&
            candidate.sourceTemplateId === report.id &&
            (candidate.status === "submitted" || candidate.status === "shared"),
        )
        .map((submission) => ({
          id: submission.id,
          title: submission.title,
          status: submission.status,
          author: {
            userId: submission.author.id,
            username: submission.author.username,
            displayName: submission.author.displayName ?? submission.author.username,
          },
        })),
    }));

    return {
      actorUserId: input.userId,
      actorDisplayName: me?.displayName ?? me?.username ?? "",
      favorites: favorites.map((row) => ({
        id: row.report.id,
        title: row.report.title,
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
            title: report.title,
            status: report.status,
            year: cycle.year,
            week: cycle.week,
          })),
      ),
      memberTemplates,
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        preview: note.body.slice(0, 80),
        authorId: note.authorId,
        updatedAt: note.updatedAt.toISOString(),
      })),
    };
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
        content: emptyHighlightContent() as unknown as Prisma.InputJsonValue,
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
   * Create a personal member weekly report with an explicit title.
   * Appears under “我的周报”; duplicate titles are allowed.
   */
  async createMemberReport(input: {
    workspaceId: string;
    userId: string;
    title: string;
    now?: Date;
  }) {
    const title = input.title.trim();
    if (!title) throw new AppError("INVALID_INPUT");
    const cycle = await this.ensureCurrentCycle(input);
    const report = await this.db.weeklyReport.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        authorId: input.userId,
        kind: "member",
        title,
        status: "draft",
        content: emptyReportContent() as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, title: true },
    });
    return {
      id: report.id,
      cycleId: cycle.id,
      title: report.title,
      year: cycle.year,
      week: cycle.week,
      kind: "member" as const,
      created: true,
    };
  }

  /**
   * Create a cycle template weekly-report document (kind=template).
   * Used by “成员周报 +”; does not appear under “我的周报”.
   * Titles may duplicate (Multica Notes-style); identity is the report UUID.
   */
  async createTemplateReport(input: {
    workspaceId: string;
    userId: string;
    title: string;
    now?: Date;
  }) {
    const title = input.title.trim();
    if (!title) throw new AppError("INVALID_INPUT");
    const cycle = await this.ensureCurrentCycle(input);
    const report = await this.db.weeklyReport.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        authorId: input.userId,
        kind: "template",
        title,
        status: "draft",
        content: emptyReportContent() as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, title: true },
    });
    return {
      id: report.id,
      cycleId: cycle.id,
      title: report.title,
      year: cycle.year,
      week: cycle.week,
      kind: "template" as const,
      created: true,
    };
  }

  async deleteTemplateReport(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId, kind: "template" },
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

  async getSubject(input: { workspaceId: string; userId: string; id: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
      include: {
        author: { select: { id: true, username: true, displayName: true } },
        cycle: { select: { id: true, year: true, week: true, title: true } },
      },
    });
    if (report) {
      const content = asReportContent(report.content);
      return {
        type: "report" as const,
        report: {
          id: report.id,
          kind: report.kind,
          title: report.title,
          status: report.status,
          content,
          submittedAt: report.submittedAt?.toISOString() ?? null,
          updatedAt: report.updatedAt.toISOString(),
          author: {
            userId: report.author.id,
            username: report.author.username,
            displayName: report.author.displayName ?? report.author.username,
          },
          cycle: report.cycle,
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
          cycle: highlight.cycle,
        },
      };
    }

    throw new AppError("NOT_FOUND");
  }

  async saveReportContent(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    content: ReportContent;
    status?: "draft" | "submitted" | "shared";
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (report.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    const updated = await this.db.weeklyReport.update({
      where: { id: report.id },
      data: {
        content: normalizeReportContent(input.content) as unknown as Prisma.InputJsonValue,
        ...(input.status
          ? {
              status: input.status,
              submittedAt:
                input.status === "submitted" || input.status === "shared" ? new Date() : null,
            }
          : {}),
      },
    });
    return { id: updated.id, status: updated.status, updatedAt: updated.updatedAt.toISOString() };
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
        content: input.content as unknown as Prisma.InputJsonValue,
        ...(input.markCompleted ? { completedAt: new Date() } : {}),
      },
    });
    return {
      id: updated.id,
      completedAt: updated.completedAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async listTemplates(input: { workspaceId: string; userId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const templates = await this.db.weeklyReportTemplate.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: { createdAt: "desc" },
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
      dimensions: asStringArray(template.dimensions),
      mainTitles: asStringArray(template.mainTitles),
      allMembers: template.allMembers,
      recipients: template.recipients.map((row) => ({
        userId: row.user.id,
        username: row.user.username,
        displayName: row.user.displayName ?? row.user.username,
      })),
    }));
  }

  async createTemplate(input: {
    workspaceId: string;
    userId: string;
    name: string;
    frequency: "weekly";
    sendTime: string;
    dimensions: string[];
    mainTitles: string[];
    allMembers: boolean;
    recipientUserIds: string[];
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    if (!isValidTemplateName(input.name)) throw new AppError("INVALID_INPUT");
    if (!input.allMembers && input.recipientUserIds.length > 0) {
      const members = await this.db.workspaceMembership.count({
        where: {
          workspaceId: input.workspaceId,
          userId: { in: input.recipientUserIds },
        },
      });
      if (members !== input.recipientUserIds.length) throw new AppError("INVALID_INPUT");
    }
    const created = await this.db.weeklyReportTemplate.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        frequency: input.frequency,
        sendTime: input.sendTime,
        dimensions: input.dimensions,
        mainTitles: input.mainTitles,
        allMembers: input.allMembers,
        recipients: input.allMembers
          ? undefined
          : {
              create: input.recipientUserIds.map((userId) => ({ userId })),
            },
      },
    });
    return { id: created.id };
  }

  async updateTemplate(input: {
    workspaceId: string;
    userId: string;
    templateId: string;
    name: string;
    frequency: "weekly";
    sendTime: string;
    dimensions: string[];
    mainTitles: string[];
    allMembers: boolean;
    recipientUserIds: string[];
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    if (!isValidTemplateName(input.name)) throw new AppError("INVALID_INPUT");
    const template = await this.db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    if (!input.allMembers && input.recipientUserIds.length > 0) {
      const members = await this.db.workspaceMembership.count({
        where: {
          workspaceId: input.workspaceId,
          userId: { in: input.recipientUserIds },
        },
      });
      if (members !== input.recipientUserIds.length) throw new AppError("INVALID_INPUT");
    }
    await this.db.$transaction(async (tx) => {
      await tx.weeklyReportTemplateRecipient.deleteMany({ where: { templateId: template.id } });
      await tx.weeklyReportTemplate.update({
        where: { id: template.id },
        data: {
          name: input.name.trim(),
          frequency: input.frequency,
          sendTime: input.sendTime,
          dimensions: input.dimensions,
          mainTitles: input.mainTitles,
          allMembers: input.allMembers,
          recipients: input.allMembers
            ? undefined
            : {
                create: input.recipientUserIds.map((userId) => ({ userId })),
              },
        },
      });
    });
    return { id: template.id };
  }

  async deleteTemplate(input: { workspaceId: string; userId: string; templateId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const template = await this.db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId },
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

export function recordCatalog(db: Db) {
  return new RecordCatalog(db);
}
