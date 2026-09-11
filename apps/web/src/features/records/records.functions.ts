import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireExistingWorkspaceId } from "../../server/workspaces/enrollment.server";
import { preferredWorkspaceSlugFromRequest } from "../../server/workspaces/selection.server";
import { recordCatalog } from "../../server/records/record-catalog.server";
import { normalizeReportContent, type ReportContent } from "./records-content";

function catalog() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return { db, catalog: recordCatalog(db) };
}

function currentUser() {
  return requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
}

async function currentWorkspaceId(userId: string) {
  const { db } = catalog();
  return requireExistingWorkspaceId(db, userId, preferredWorkspaceSlugFromRequest());
}

const reportContentSchema: z.ZodType<ReportContent> = z.object({
  markdown: z.string(),
});

const highlightContentSchema = z.object({
  blocks: z.array(
    z.object({
      id: z.string().min(1),
      heading: z.string(),
      paragraphs: z.array(z.string()),
      items: z.array(z.string()),
    }),
  ),
});

export const loadRecordsCatalog = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  const workspaceId = await currentWorkspaceId(user.id);
  return catalog().catalog.loadCatalog({ workspaceId, userId: user.id });
});

export const createWeeklyHighlight = createServerFn({ method: "POST" }).handler(async () => {
  const user = currentUser();
  const workspaceId = await currentWorkspaceId(user.id);
  return catalog().catalog.createHighlight({ workspaceId, userId: user.id });
});

export const createMemberWeeklyReport = createServerFn({ method: "POST" })
  .validator(z.object({ title: z.string().trim().min(1).max(120) }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.createMemberReport({
      workspaceId,
      userId: user.id,
      title: data.title,
    });
  });

export const createTemplateWeeklyReport = createServerFn({ method: "POST" })
  .validator(z.object({ title: z.string().trim().min(1).max(120) }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.createTemplateReport({
      workspaceId,
      userId: user.id,
      title: data.title,
    });
  });

export const createTemplateChildReport = createServerFn({ method: "POST" })
  .validator(z.object({ templateId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspaceId = await currentWorkspaceId(user.id);
    return catalog().catalog.createSubmissionUnderTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
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
      content: data.content,
      markCompleted: data.markCompleted,
    });
  });

export const loadWeeklyTemplates = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  const workspaceId = await currentWorkspaceId(user.id);
  return catalog().catalog.listTemplates({ workspaceId, userId: user.id });
});

export const createWeeklyTemplate = createServerFn({ method: "POST" })
  .validator(
    z.object({
      name: z.string().trim().min(1),
      frequency: z.literal("weekly"),
      sendTime: z.string().min(1),
      dimensions: z.array(z.string()),
      mainTitles: z.array(z.string()),
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
      dimensions: z.array(z.string()),
      mainTitles: z.array(z.string()),
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
    return catalog().catalog.addUserComment({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      body: data.body,
    });
  });
