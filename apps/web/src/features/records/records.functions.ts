import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireExistingWorkspaceId } from "../../server/workspaces/enrollment.server";
import { preferredWorkspaceSlugFromRequest } from "../../server/workspaces/selection.server";
import { recordCatalog } from "../../server/records/record-catalog.server";
import { tryCreateWeeklyAssignmentDelivery } from "../../server/records/weekly-assignment-delivery-composition.server";
import {
  normalizeReportContent,
  normalizeHighlightContent,
  type ReportContent,
} from "./records-content";

function catalog() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return { db, catalog: recordCatalog(db) };
}

function catalogWithChannelDelivery() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return { db, catalog: recordCatalog(db, tryCreateWeeklyAssignmentDelivery(db)) };
}

function currentUser() {
  return requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
}

async function currentWorkspaceId(userId: string) {
  const { db } = catalog();
  return requireExistingWorkspaceId(db, userId, preferredWorkspaceSlugFromRequest());
}

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

export const loadRecordsCatalog = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  const workspaceId = await currentWorkspaceId(user.id);
  return catalog().catalog.loadCatalog({ workspaceId, userId: user.id });
});

export const loadRecordsNavAttention = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  const workspaceId = await currentWorkspaceId(user.id);
  return catalog().catalog.loadNavAttention({ workspaceId, userId: user.id });
});

export const createWeeklyHighlight = createServerFn({ method: "POST" }).handler(async () => {
  const user = currentUser();
  const workspaceId = await currentWorkspaceId(user.id);
  return catalog().catalog.createHighlight({ workspaceId, userId: user.id });
});

export const deleteTemplateWeeklyReport = createServerFn({ method: "POST" })
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.deleteTemplateReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const deleteMemberWeeklyReport = createServerFn({ method: "POST" })
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.deleteMemberReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const setWeeklyReportFavorite = createServerFn({ method: "POST" })
  .validator(
    z.object({
      reportId: z.string().uuid(),
      favorited: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.setReportFavorite({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      favorited: data.favorited,
    });
  });

export const deleteWeeklyCycle = createServerFn({ method: "POST" })
  .validator(z.object({ cycleId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.deleteCycle({
      workspaceId,
      userId: user.id,
      cycleId: data.cycleId,
    });
  });

export const loadRecordSubject = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.getSubject({ workspaceId, userId: user.id, id: data.id });
  });

export const createRecordNote = createServerFn({ method: "POST" })
  .validator(z.object({ title: z.string().trim().max(200).optional() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.createNote({
      workspaceId,
      userId: user.id,
      title: data.title,
    });
  });

export const saveRecordNote = createServerFn({ method: "POST" })
  .validator(
    z.object({
      noteId: z.string().uuid(),
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.saveNote({
      workspaceId,
      userId: user.id,
      noteId: data.noteId,
      title: data.title,
      body: data.body,
    });
  });

export const deleteRecordNote = createServerFn({ method: "POST" })
  .validator(z.object({ noteId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.deleteNote({
      workspaceId,
      userId: user.id,
      noteId: data.noteId,
    });
  });

export const saveWeeklyReportContent = createServerFn({ method: "POST" })
  .validator(
    z.object({
      reportId: z.string().uuid(),
      content: reportContentSchema,
      status: z.enum(["draft", "submitted", "shared"]).optional(),
      askToSend: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.saveReportContent({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      content: normalizeReportContent(data.content),
      status: data.status,
      askToSend: data.askToSend,
    });
  });

export const markWeeklyAssignmentOpened = createServerFn({ method: "POST" })
  .validator(z.object({ reportId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.markAssignmentOpened({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const sendWeeklyReportAssignments = createServerFn({ method: "POST" })
  .validator(
    z.object({
      sourceReportId: z.string().uuid(),
      content: z.unknown().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalogWithChannelDelivery().catalog.sendWeeklyAssignments({
      workspaceId,
      userId: user.id,
      sourceReportId: data.sourceReportId,
      content: data.content === undefined ? undefined : normalizeReportContent(data.content),
    });
  });

export const saveWeeklyHighlightContent = createServerFn({ method: "POST" })
  .validator(
    z.object({
      highlightId: z.string().uuid(),
      content: highlightContentSchema,
      markCompleted: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.saveHighlightContent({
      workspaceId,
      userId: user.id,
      highlightId: data.highlightId,
      content: normalizeHighlightContent(data.content),
      markCompleted: data.markCompleted,
    });
  });

export const saveWeeklyHighlightPrompt = createServerFn({ method: "POST" })
  .validator(
    z.object({
      reportId: z.string().uuid(),
      text: z.string().max(20_000),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.saveHighlightPrompt({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      text: data.text,
    });
  });

export const loadWeeklyTemplates = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  const workspaceId = await currentWorkspaceId(user.id);
  return catalog().catalog.listTemplates({ workspaceId, userId: user.id });
});

export const applyWeeklyTemplate = createServerFn({ method: "POST" })
  .validator(z.object({ templateId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.applyTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
  });

export const setWeeklyTemplateScheduleEnabled = createServerFn({ method: "POST" })
  .validator(
    z.object({
      templateId: z.string().uuid(),
      scheduleEnabled: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.setTemplateScheduleEnabled({
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
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.createTemplate({ workspaceId, userId: user.id, ...data });
  });

export const updateWeeklyTemplate = createServerFn({ method: "POST" })
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
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.updateTemplate({
      workspaceId,
      userId: user.id,
      ...data,
    });
  });

export const deleteWeeklyTemplate = createServerFn({ method: "POST" })
  .validator(z.object({ templateId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.deleteTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
  });

export const loadWeeklyReportStats = createServerFn({ method: "GET" })
  .validator(z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.loadStats({
      workspaceId,
      userId: user.id,
      year: data.year,
      month: data.month,
    });
  });

export const loadRecordComments = createServerFn({ method: "GET" })
  .validator(
    z.object({
      subjectType: z.enum(["report", "highlight", "cycle"]),
      subjectId: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.listComments({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
    });
  });

export const addRecordComment = createServerFn({ method: "POST" })
  .validator(
    z.object({
      subjectType: z.enum(["report", "highlight", "cycle"]),
      subjectId: z.string().uuid(),
      body: z.string().trim().min(1).max(4000),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.postSideChat({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      body: data.body,
    });
  });

export const ensureRecordAssistantIntro = createServerFn({ method: "POST" })
  .validator(
    z.object({
      subjectType: z.enum(["report", "highlight", "cycle"]),
      subjectId: z.string().uuid(),
      surface: z.enum(["format", "member-leader", "highlight", "plain"]),
      formatCopy: z.enum(["preview", "cancelled", "ready"]).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.ensureAssistantIntro({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      surface: data.surface,
      formatCopy: data.formatCopy,
    });
  });

export const generateWeeklyHighlights = createServerFn({ method: "POST" })
  .validator(
    z.object({
      reportId: z.string().uuid(),
      memberIds: z.union([z.literal("all"), z.array(z.string().uuid()).min(1)]),
    }),
  )
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.generateWeeklyHighlights({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      memberIds: data.memberIds,
    });
  });
