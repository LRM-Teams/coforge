import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "../auth/function-auth";
import { AppError } from "../../lib/app-error";

import { recordCatalog } from "../../server/records/record-catalog.server";
import {
  ensureWeeklyReportAssistant,
  WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
} from "../../server/records/weekly-report-assistant.server";
import { openWeeklyReportAssistantChat } from "../../server/records/weekly-report-assistant-chat.server";
import { parseAgentRuntimeConfig } from "../../server/agents/agent-runtime-config.server";
import {
  looksLikeMemberReportRuleIntent,
  looksLikeSideChatGreeting,
} from "./weekly-highlight-extract";
import { normalizeReportContent, type ReportContent } from "./records-content";

export const loadRecordsNavAttention = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadNavAttention({ workspaceId, userId: user.id });
  });

function normalizeAgentRuntimeConfig(value: unknown) {
  try {
    return parseAgentRuntimeConfig(value);
  } catch {
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  }
}

const reportContentSchema: z.ZodType<ReportContent> = z.object({
  tabs: z.record(z.string(), z.object({ markdown: z.string() })),
  markdown: z.string().optional(),
  assignment: z.object({ unread: z.boolean() }).optional(),
});

export const loadRecordsCatalog = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadCatalog({ workspaceId, userId: user.id });
  });

export const createTemplateChildReport = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ templateId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).createSubmissionUnderTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
  });

export const loadWeeklyReportAssistantStatus = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return readWeeklyReportAssistantStatus(db, user.id, workspaceId);
  });

async function readWeeklyReportAssistantStatus(
  db: Parameters<typeof recordCatalog>[0],
  userId: string,
  workspaceId: string,
) {
  const assistant = await ensureWeeklyReportAssistant(db, {
    workspaceId,
    userId,
  });
  const agent = await db.agent.findUnique({
    where: { id_workspaceId: { id: assistant.agentId, workspaceId } },
    select: { ownerId: true, computerId: true, runtimeConfig: true },
  });
  if (!agent || agent.ownerId !== userId) throw new AppError("ACCESS_DENIED");
  const runtimeConfig = normalizeAgentRuntimeConfig(agent.runtimeConfig);
  return {
    assistantId: assistant.id,
    agentId: assistant.agentId,
    displayName: WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
    computerConfigured: Boolean(agent.computerId),
    runtimeConfigured:
      runtimeConfig.runtime !== "coforge" ||
      (runtimeConfig.provider.kind === "coforge" && Boolean(runtimeConfig.provider.apiKey)),
    runtime: runtimeConfig.runtime,
  };
}

export const deleteTemplateWeeklyReport = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteTemplateReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const deleteMemberWeeklyReport = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteMemberReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const setWeeklyReportFavorite = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      favorited: z.boolean(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).setReportFavorite({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      favorited: data.favorited,
    });
  });

export const deleteWeeklyCycle = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ cycleId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteCycle({
      workspaceId,
      userId: user.id,
      cycleId: data.cycleId,
    });
  });

/** Deletes the Leader overview week node without removing member or favorited reports. */
export const deleteOverviewReport = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteOverviewReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

/** Deletes the viewer's member-week node (templates + submissions). */
export const deleteMemberWeek = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ cycleId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteMemberWeek({
      workspaceId,
      userId: user.id,
      cycleId: data.cycleId,
    });
  });

export const loadRecordSubject = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).getSubject({ workspaceId, userId: user.id, id: data.id });
  });

export const loadWeeklyReportAssistantContext = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadAssistantContextManifest({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
    });
  });

export const listWeeklyReportAssistantReports = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      cycleId: z.string().uuid().optional(),
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).listAssistantVisibleReports({
      workspaceId,
      userId: user.id,
      cycleId: data.cycleId,
      cursor: data.cursor,
      limit: data.limit,
    });
  });

export const readWeeklyReportAssistantSection = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      section: z.string().trim().min(1).max(100),
      maxCharacters: z.number().int().min(1).max(12_000).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).readAssistantReportSection({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      section: data.section,
      maxCharacters: data.maxCharacters,
    });
  });

export const createRecordNote = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ title: z.string().trim().max(200).optional() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).createNote({
      workspaceId,
      userId: user.id,
      title: data.title,
    });
  });

export const saveRecordNote = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      noteId: z.string().uuid(),
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveNote({
      workspaceId,
      userId: user.id,
      noteId: data.noteId,
      title: data.title,
      body: data.body,
    });
  });

export const deleteRecordNote = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ noteId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteNote({
      workspaceId,
      userId: user.id,
      noteId: data.noteId,
    });
  });

export const saveWeeklyReportContent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      content: reportContentSchema,
      status: z.enum(["draft", "submitted", "shared"]).optional(),
      askToSend: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveReportContent({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      content: normalizeReportContent(data.content),
      status: data.status,
      askToSend: data.askToSend,
    });
  });

export const updateFormatReportMeta = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      title: z.string().trim().min(1),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).updateFormatReportMeta({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      title: data.title,
    });
  });

export const markWeeklyAssignmentOpened = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).markAssignmentOpened({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const sendWeeklyReportAssignments = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      sourceReportId: z.string().uuid(),
      content: z.unknown().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).sendWeeklyAssignments({
      workspaceId,
      userId: user.id,
      sourceReportId: data.sourceReportId,
      content: data.content === undefined ? undefined : normalizeReportContent(data.content),
    });
  });

export const applyConfirmedWeeklyReportBody = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      content: reportContentSchema,
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).applyConfirmedReportBody({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      content: normalizeReportContent(data.content),
    });
  });

export const applyConfirmedKeyPointMarkdown = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      markdown: z.string().trim().min(1).max(100_000),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).applyConfirmedKeyPointMarkdown({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      markdown: data.markdown,
    });
  });

export const dismissKeyPointConfirmDraft = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).dismissKeyPointConfirmDraft({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const loadWeeklyTemplates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).listTemplates({ workspaceId, userId: user.id });
  });

export const loadKeyPointPrompts = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadKeyPointPrompts({ workspaceId, userId: user.id });
  });

export const saveKeyPointPrompts = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      slot: z.enum(["team", "personal"]),
      text: z.string(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveKeyPointPrompts({
      workspaceId,
      userId: user.id,
      slot: data.slot,
      text: data.text,
    });
  });

export const deleteKeyPointPromptHistory = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      slot: z.enum(["team", "personal"]),
      historyIndex: z.number().int().min(0),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteKeyPointPromptHistory({
      workspaceId,
      userId: user.id,
      slot: data.slot,
      historyIndex: data.historyIndex,
    });
  });

export const restartPersonalKeyPointExtraction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).restartPersonalKeyPointExtraction({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const startTeamKeyPointExtraction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      overviewReportId: z.string().uuid(),
      force: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).startTeamKeyPointExtraction({
      workspaceId,
      userId: user.id,
      overviewReportId: data.overviewReportId,
      force: data.force,
    });
  });

/** Overview side chat: User「重新整理」→ confirm-mode team extraction. */
export const startTeamKeyPointExtractionFromSideChat = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      overviewReportId: z.string().uuid(),
      sessionId: z.string().uuid(),
      body: z.string().trim().min(1).max(4000),
      requestId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).startTeamKeyPointExtractionFromSideChat({
      workspaceId,
      userId: user.id,
      overviewReportId: data.overviewReportId,
      sessionId: data.sessionId,
      body: data.body,
      requestId: data.requestId,
    });
  });

export const applyWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ templateId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).applyTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
  });

export const setWeeklyTemplateScheduleEnabled = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      templateId: z.string().uuid(),
      scheduleEnabled: z.boolean(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).setTemplateScheduleEnabled({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
      scheduleEnabled: data.scheduleEnabled,
    });
  });

const templateSectionSchema = z.object({
  title: z.string(),
  children: z.array(z.string()),
});

export const createWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      name: z.string().trim().min(1),
      frequency: z.literal("weekly"),
      sendTime: z.string().min(1),
      sendWeekday: z.number().int().min(1).max(7),
      scheduleEnabled: z.boolean(),
      sections: z.array(templateSectionSchema),
      allMembers: z.boolean(),
      recipientUserIds: z.array(z.string().uuid()),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).createTemplate({ workspaceId, userId: user.id, ...data });
  });

export const updateWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      templateId: z.string().uuid(),
      name: z.string().trim().min(1),
      frequency: z.literal("weekly"),
      sendTime: z.string().min(1),
      sendWeekday: z.number().int().min(1).max(7),
      scheduleEnabled: z.boolean(),
      sections: z.array(templateSectionSchema),
      allMembers: z.boolean(),
      recipientUserIds: z.array(z.string().uuid()),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).updateTemplate({
      workspaceId,
      userId: user.id,
      ...data,
    });
  });

export const deleteWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ templateId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
  });

export const loadWeeklyReportStats = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadStats({
      workspaceId,
      userId: user.id,
      year: data.year,
      month: data.month,
    });
  });

export const loadRecordComments = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
      assistantSessionId: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).listComments({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      assistantSessionId: data.assistantSessionId,
    });
  });

export const addRecordComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
      body: z.string().trim().min(1).max(4000),
      assistantSessionId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).postSideChat({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      body: data.body,
      assistantSessionId: data.assistantSessionId,
    });
  });

function weeklyReportAssistantChat(db: Parameters<typeof recordCatalog>[0]) {
  return openWeeklyReportAssistantChat(db);
}

export const ensureWeeklyReportAssistantChatSessions = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { ensureWeeklyReportAssistantChatSession } =
      await import("../../server/records/weekly-report-assistant-chat-session.server");
    return ensureWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
    });
  });

export const createWeeklyReportAssistantChatSessionFn = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
      title: z.string().max(80).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { createWeeklyReportAssistantChatSession } =
      await import("../../server/records/weekly-report-assistant-chat-session.server");
    return createWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      title: data.title,
    });
  });

export const renameWeeklyReportAssistantChatSessionFn = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      sessionId: z.string().uuid(),
      title: z.string().trim().min(1).max(80),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { renameWeeklyReportAssistantChatSession } =
      await import("../../server/records/weekly-report-assistant-chat-session.server");
    return renameWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
      title: data.title,
    });
  });

export const archiveWeeklyReportAssistantChatSessionFn = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ sessionId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { archiveWeeklyReportAssistantChatSession } =
      await import("../../server/records/weekly-report-assistant-chat-session.server");
    return archiveWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
    });
  });

export const postWeeklyReportAssistantRequest = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
      sessionId: z.string().uuid(),
      body: z.string().trim().min(1).max(4000),
      requestId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { requireOwnedChatSession, touchWeeklyReportAssistantChatSession } =
      await import("../../server/records/weekly-report-assistant-chat-session.server");
    await requireOwnedChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
    });
    if (looksLikeSideChatGreeting(data.body)) {
      const comments = await recordCatalog(db).postSideChat({
        workspaceId,
        userId: user.id,
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        body: data.body,
        assistantSessionId: data.sessionId,
      });
      await touchWeeklyReportAssistantChatSession(db, {
        workspaceId,
        userId: user.id,
        sessionId: data.sessionId,
        title: data.body,
      });
      return { kind: "rule" as const, comments };
    }
    if (data.subjectType === "report" && looksLikeMemberReportRuleIntent(data.body)) {
      const comments = await recordCatalog(db).postMemberReportRuleSideChatIfApplicable({
        workspaceId,
        userId: user.id,
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        body: data.body,
        assistantSessionId: data.sessionId,
      });
      if (comments) {
        await touchWeeklyReportAssistantChatSession(db, {
          workspaceId,
          userId: user.id,
          sessionId: data.sessionId,
          title: data.body,
        });
        return { kind: "rule" as const, comments };
      }
    }
    const status = await readWeeklyReportAssistantStatus(db, user.id, workspaceId);
    if (!status.computerConfigured || !status.runtimeConfigured) {
      return { kind: "needs_setup" as const, status };
    }
    const posted = await weeklyReportAssistantChat(db).postRequest({
      workspaceId,
      userId: user.id,
      requestId: data.requestId,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      sessionId: data.sessionId,
      body: data.body,
    });
    await touchWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
      title: data.body,
    });
    return { kind: "agent" as const, ...posted };
  });

export const loadWeeklyReportAssistantMessages = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
      sessionId: z.string().uuid(),
      includeLegacyUnscoped: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return weeklyReportAssistantChat(db).listMessages({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      sessionId: data.sessionId,
      includeLegacyUnscoped: data.includeLegacyUnscoped,
    });
  });

export const ensureRecordAssistantIntro = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.string().uuid(),
      assistantSessionId: z.string().uuid(),
      surface: z.enum(["format", "member-leader", "member-assignee", "plain"]),
      formatCopy: z.enum(["preview", "cancelled", "ready"]).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).ensureAssistantIntro({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      assistantSessionId: data.assistantSessionId,
      surface: data.surface,
      formatCopy: data.formatCopy,
    });
  });

export const dismissWeeklyFormatSend = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      assistantSessionId: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).dismissWeeklyFormatSend({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
    });
  });

export const acceptMemberGenerateHelp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      assistantSessionId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).acceptMemberGenerateHelp({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
    });
  });

export const confirmMemberReportIntent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      assistantSessionId: z.string().uuid(),
      intent: z.enum(["collect-again", "synthesize"]),
      userGuidance: z.string().max(4000).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).confirmMemberReportIntent({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
      intent: data.intent,
      userGuidance: data.userGuidance,
    });
  });

export const declineMemberReportIntent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      assistantSessionId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const declined = await recordCatalog(db).declineMemberReportIntent({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
    });
    let forwarded = false;
    const original = declined.originalUserText?.trim();
    if (original) {
      const status = await readWeeklyReportAssistantStatus(db, user.id, workspaceId);
      if (status.computerConfigured && status.runtimeConfigured) {
        const { touchWeeklyReportAssistantChatSession } =
          await import("../../server/records/weekly-report-assistant-chat-session.server");
        await weeklyReportAssistantChat(db).postRequest({
          workspaceId,
          userId: user.id,
          requestId: crypto.randomUUID(),
          subjectType: "report",
          subjectId: data.reportId,
          sessionId: data.assistantSessionId,
          body: original,
        });
        await touchWeeklyReportAssistantChatSession(db, {
          workspaceId,
          userId: user.id,
          sessionId: data.assistantSessionId,
          title: original,
        });
        forwarded = true;
      }
    }
    return { comments: declined.comments, forwarded };
  });

export const listWeeklyReportCollectorSlots = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const { loadCollectPlanSlots } =
      await import("../../server/records/weekly-report-collect-orchestrate.server");
    return loadCollectPlanSlots(db, { workspaceId, userId: user.id });
  });

export const ensureWeeklyReportCollector = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ computerId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { ensureCollectPlanCollector } =
      await import("../../server/records/weekly-report-collect-orchestrate.server");
    return ensureCollectPlanCollector(db, {
      workspaceId,
      userId: user.id,
      computerId: data.computerId,
    });
  });

export const submitWeeklyReportCollectPlan = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      windowKind: z.enum(["week", "month", "quarter", "year", "custom"]),
      year: z.number().int().optional(),
      week: z.number().int().optional(),
      month: z.number().int().optional(),
      quarter: z.number().int().optional(),
      customStart: z.string().optional(),
      customEnd: z.string().optional(),
      computers: z
        .array(
          z.object({
            computerId: z.string().uuid(),
            scanPaths: z.array(z.string()),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { submitWeeklyReportCollectPlan: submit } =
      await import("../../server/records/weekly-report-collect-orchestrate.server");
    return submit(db, {
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      windowKind: data.windowKind,
      year: data.year,
      week: data.week,
      month: data.month,
      quarter: data.quarter,
      customStart: data.customStart,
      customEnd: data.customEnd,
      computers: data.computers,
    });
  });

export const loadWeeklyReportCollectRun = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ runId: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { getCollectRunWithPacks } =
      await import("../../server/records/weekly-report-collect-run.server");
    return getCollectRunWithPacks(db, {
      workspaceId,
      userId: user.id,
      runId: data.runId,
    });
  });
