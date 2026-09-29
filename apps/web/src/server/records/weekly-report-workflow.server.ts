import type { WeeklyReportWorkflowAction } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { loadKeyPointPromptForLeader } from "./weekly-report-key-points.server";
import { RecordCatalog } from "./record-catalog.server";
import {
  distributeWeeklyReport,
  type WeeklyReportNotifier,
} from "./weekly-report-distribution.server";
import {
  normalizeReportContent,
  DEFAULT_TEAM_KEY_POINT_PROMPT,
  reportContentForRecipient,
} from "#src/features/records/records-content";

type Actor = { workspaceId: string; userId: string };

/** Conversation operations share the same owner and workspace as Records. */
export class WeeklyReportWorkflow {
  constructor(
    private readonly db: PrismaClient,
    private readonly notifier?: WeeklyReportNotifier,
  ) {}

  async execute(actor: Actor, action: WeeklyReportWorkflowAction): Promise<unknown> {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: actor },
      select: { role: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
    const catalog = new RecordCatalog(this.db, this.notifier);
    if (action.type === "templates")
      return catalog.listAssistantTemplateFormats({ ...actor, ...action });
    if (action.type === "configure") {
      const { type: _type, requestId, templateId, ...configuration } = action;
      if (new Set(configuration.recipientUserIds).size !== configuration.recipientUserIds.length)
        throw new AppError("INVALID_INPUT");
      if (templateId)
        return catalog.updateTemplate({
          ...actor,
          ...configuration,
          templateId,
          frequency: "weekly",
        });
      // A stable caller request UUID identifies retries, scoped to the authenticated owner.
      const hash = new Bun.CryptoHasher("sha256")
        .update(`${actor.workspaceId}:${actor.userId}:${requestId}`)
        .digest("hex")
        .slice(0, 32);
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
      const existing = await this.db.weeklyReportTemplate.findFirst({
        where: { id, workspaceId: actor.workspaceId, ownerId: actor.userId },
        select: { id: true },
      });
      if (existing) return existing;
      try {
        return await catalog.createTemplate({
          ...actor,
          ...configuration,
          id,
          frequency: "weekly",
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const replay = await this.db.weeklyReportTemplate.findFirst({
          where: { id, workspaceId: actor.workspaceId, ownerId: actor.userId },
          select: { id: true },
        });
        if (replay) return replay;
        throw error;
      }
    }
    if (action.type === "send")
      return distributeWeeklyReport(
        this.db,
        { ...actor, templateId: action.templateId },
        this.notifier,
      );
    if (action.type === "inbox") {
      const limit = action.limit ?? 25;
      const rows = await this.db.weeklyReport.findMany({
        where: { workspaceId: actor.workspaceId, authorId: actor.userId, hiddenFromAuthor: false },
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(action.cursor ? { cursor: { id: action.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          title: true,
          kind: true,
          status: true,
          settingsId: true,
          sourceTemplateId: true,
          cycle: { select: { id: true, year: true, week: true } },
          updatedAt: true,
        },
      });
      return {
        reports: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    }
    if (action.type === "members") {
      const limit = action.limit ?? 25;
      const rows = await this.db.user.findMany({
        where: {
          memberships: { some: { workspaceId: actor.workspaceId } },
          ...(action.query
            ? {
                OR: [
                  { username: { contains: action.query, mode: "insensitive" as const } },
                  { displayName: { contains: action.query, mode: "insensitive" as const } },
                ],
              }
            : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(action.cursor ? { cursor: { id: action.cursor }, skip: 1 } : {}),
        select: { id: true, username: true, displayName: true },
      });
      return {
        members: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    }
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: action.reportId,
        workspaceId: actor.workspaceId,
        authorId: actor.userId,
        hiddenFromAuthor: false,
      },
      select: { id: true, kind: true, content: true, settingsId: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    const summaryPrompt =
      report.kind === "template" &&
      (action.type === "summary" || (action.type === "sources" && !action.sourceReportId))
        ? (
            await loadKeyPointPromptForLeader(this.db, {
              workspaceId: actor.workspaceId,
              leaderUserId: actor.userId,
              settingsId: report.settingsId,
              slot: "team",
            })
          ).text.trim() || DEFAULT_TEAM_KEY_POINT_PROMPT
        : undefined;
    if (action.type === "sources" || action.type === "status") {
      if (report.kind !== "template") throw new AppError("INVALID_INPUT");
      const limit = action.limit ?? 25;
      const sourceReportId = action.type === "sources" ? action.sourceReportId : undefined;
      const rows = await this.db.weeklyReport.findMany({
        where: {
          workspaceId: actor.workspaceId,
          sourceTemplateId: report.id,
          kind: "member",
          ...(action.type === "sources" ? { status: { in: ["submitted", "shared"] } } : {}),
          ...(sourceReportId ? { id: sourceReportId } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(action.cursor ? { cursor: { id: action.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          status: true,
          submittedAt: true,
          content: action.type === "sources",
          author: { select: { id: true, username: true, displayName: true } },
        },
      });
      if (sourceReportId && !rows.length) throw new AppError("NOT_FOUND");
      return {
        ...(summaryPrompt ? { summaryPrompt } : {}),
        reports: rows.slice(0, limit).map((row) => {
          const metadata = {
            id: row.id,
            author: row.author,
            status: row.status,
            submittedAt: row.submittedAt,
          };
          if (action.type === "status") return metadata;
          const tabs = reportContentForRecipient(normalizeReportContent(row.content)).tabs ?? {};
          if (!action.section) return { ...metadata, sections: Object.keys(tabs) };
          const tab = tabs[action.section];
          if (!tab) throw new AppError("NOT_FOUND");
          const offset = action.offset ?? 0;
          const markdown = tab.markdown.slice(offset, offset + 12_000);
          const nextOffset =
            offset + markdown.length < tab.markdown.length ? offset + markdown.length : null;
          return { ...metadata, section: action.section, markdown, nextOffset };
        }),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    }
    if (action.type === "summary")
      return catalog.applyConfirmedKeyPointMarkdown({
        ...actor,
        reportId: report.id,
        markdown: action.markdown,
        ...(summaryPrompt ? { promptSnapshot: summaryPrompt } : {}),
      });
    if (report.kind !== "member") throw new AppError("INVALID_INPUT");
    const content = normalizeReportContent(report.content);
    if (action.type === "save") {
      const tabs = Object.keys(content.tabs ?? {});
      if (Object.keys(action.tabs).some((tab) => !tabs.includes(tab)))
        throw new AppError("INVALID_INPUT");
      return catalog.saveReportContent({
        ...actor,
        reportId: report.id,
        content: { ...content, tabs: { ...content.tabs, ...action.tabs } },
        askToSend: false,
      });
    }
    return catalog.saveReportContent({
      ...actor,
      reportId: report.id,
      content,
      status: "submitted",
      askToSend: false,
    });
  }
}
