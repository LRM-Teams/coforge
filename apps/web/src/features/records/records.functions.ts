import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "../../server/auth/function-auth";

import { recordCatalog } from "../../server/records/record-catalog.server";
import { tryCreateWeeklyAssignmentDelivery } from "../../server/records/weekly-assignment-delivery-composition.server";
import {
  normalizeReportContent,
  normalizeHighlightContent,
  type ReportContent,
} from "./records-content";

export const loadRecordsNavAttention = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadNavAttention({ workspaceId, userId: user.id });
  });

export const saveWeeklyHighlightPrompt = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.string().uuid(), text: z.string().max(20_000) }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveHighlightPrompt({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      text: data.text,
    });
  });

const reportContentSchema: z.ZodType<ReportContent> = z.object({
  tabs: z.record(z.string(), z.object({ markdown: z.string() })),
  markdown: z.string().optional(),
  assignment: z.object({ unread: z.boolean() }).optional(),
});

const highlightContentSchema = z.object({
  generating: z.boolean().optional(),
  blocks: z.array(
    z.object({
      id: z.string().min(1),
      heading: z.string(),
      paragraphs: z.array(z.string()),
      items: z.array(
        z.union([
          z.string(),
          z.object({
            text: z.string(),
            sources: z.array(
              z.object({
                reportId: z.string().min(1),
                userId: z.string().min(1),
                displayName: z.string(),
              }),
            ),
          }),
        ]),
      ),
    }),
  ),
});

export const loadRecordsCatalog = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadCatalog({ workspaceId, userId: user.id });
  });

export const createWeeklyHighlight = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).createHighlight({ workspaceId, userId: user.id });
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

export const loadRecordSubject = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).getSubject({ workspaceId, userId: user.id, id: data.id });
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
    return recordCatalog(db, tryCreateWeeklyAssignmentDelivery(db)).sendWeeklyAssignments({
      workspaceId,
      userId: user.id,
      sourceReportId: data.sourceReportId,
      content: data.content === undefined ? undefined : normalizeReportContent(data.content),
    });
  });

export const saveWeeklyHighlightContent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      highlightId: z.string().uuid(),
      content: highlightContentSchema,
      markCompleted: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveHighlightContent({
      workspaceId,
      userId: user.id,
      highlightId: data.highlightId,
      content: normalizeHighlightContent(data.content),
      markCompleted: data.markCompleted,
    });
  });

export const loadWeeklyTemplates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).listTemplates({ workspaceId, userId: user.id });
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
      subjectType: z.enum(["report", "highlight", "cycle"]),
      subjectId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).listComments({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
    });
  });

export const addRecordComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "highlight", "cycle"]),
      subjectId: z.string().uuid(),
      body: z.string().trim().min(1).max(4000),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).postSideChat({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      body: data.body,
    });
  });

export const ensureRecordAssistantIntro = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "highlight", "cycle"]),
      subjectId: z.string().uuid(),
      surface: z.enum(["format", "member-leader", "highlight", "plain"]),
      formatCopy: z.enum(["preview", "cancelled", "ready"]).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).ensureAssistantIntro({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      surface: data.surface,
      formatCopy: data.formatCopy,
    });
  });

export const generateWeeklyHighlights = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.string().uuid(),
      memberIds: z.union([z.literal("all"), z.array(z.string().uuid()).min(1)]),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).generateWeeklyHighlights({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      memberIds: data.memberIds,
    });
  });
