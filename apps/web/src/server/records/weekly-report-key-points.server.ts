import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { createCentrifugoServerApi } from "../centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "../conversations/conversation-realtime.server";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import { getMessageRequestIdempotency } from "../conversations/redis-message-request-idempotency.server";
import { parseAgentRuntimeConfig } from "../agents/agent-runtime-config.server";
import {
  DEFAULT_PERSONAL_KEY_POINT_PROMPT,
  normalizeReportContent,
  withKeyPointExtraction,
  type KeyPointExtractionMeta,
  type KeyPointPromptState,
  type KeyPointPromptsMeta,
  type ReportContent,
  applyKeyPointPromptText,
  emptyKeyPointPrompts,
} from "../../features/records/records-content";
import { ensureWeeklyReportAssistant } from "./weekly-report-assistant.server";
import { WeeklyReportAssistantChat } from "./weekly-report-assistant-chat.server";
import { ensureWeeklyReportAssistantChatSession } from "./weekly-report-assistant-chat-session.server";

export function isWeeklyReportAssistantReady(agent: {
  computerId: string | null;
  runtimeConfig: unknown;
}): boolean {
  if (!agent.computerId) return false;
  try {
    const runtimeConfig = parseAgentRuntimeConfig(agent.runtimeConfig);
    return (
      runtimeConfig.runtime !== "coforge" ||
      (runtimeConfig.provider.kind === "coforge" && Boolean(runtimeConfig.provider.apiKey))
    );
  } catch {
    return false;
  }
}

export function buildPersonalKeyPointWakeText(input: {
  reportId: string;
  prompt: string;
  authorDisplayName: string;
  year: number;
  week: number;
}): string {
  return [
    "[weekly-report-key-points]",
    `reportId: ${input.reportId}`,
    `member: ${input.authorDisplayName}`,
    `week: ${input.year} W${input.week}`,
    "",
    "平台已触发「个人要点提炼」。请按下列提示词阅读该成员周报全文，提炼要点，",
    "然后通过 `coforge weekly-report-key-points submit` 写回 markdown（不要用 body-edit Confirm）。",
    "",
    "## 提示词",
    input.prompt.trim() || DEFAULT_PERSONAL_KEY_POINT_PROMPT,
  ].join("\n");
}

export async function resolvePersonalPromptFromFormat(
  content: ReportContent,
): Promise<KeyPointPromptState> {
  const prompts = content.keyPointPrompts ?? emptyKeyPointPrompts();
  return prompts.personal;
}

/** Persist extraction meta onto a member report. */
export async function writeKeyPointExtraction(
  db: PrismaClient,
  input: { reportId: string; content: ReportContent; extraction: KeyPointExtractionMeta },
): Promise<ReportContent> {
  const next = withKeyPointExtraction(input.content, input.extraction);
  await db.weeklyReport.update({
    where: { id: input.reportId },
    data: { content: next as never },
  });
  return next;
}

/**
 * After a member first submits, start personal key-point extraction for the
 * Leader who owns the source template. Idempotent when already generating/ready.
 */
export async function startPersonalKeyPointExtraction(
  db: PrismaClient,
  input: {
    workspaceId: string;
    memberReportId: string;
    /** When true, re-run even if status is already generating/ready. */
    force?: boolean;
    /** Optional hook for tests; defaults to waking the Leader assistant. */
    wake?: (args: {
      workspaceId: string;
      leaderUserId: string;
      reportId: string;
      sessionId: string;
      body: string;
    }) => Promise<void>;
  },
): Promise<{ started: boolean; status: KeyPointExtractionMeta["status"] }> {
  const report = await db.weeklyReport.findFirst({
    where: {
      id: input.memberReportId,
      workspaceId: input.workspaceId,
      kind: "member",
    },
    select: {
      id: true,
      content: true,
      status: true,
      authorId: true,
      sourceTemplateId: true,
      author: { select: { username: true, displayName: true } },
      cycle: { select: { year: true, week: true } },
      sourceTemplate: {
        select: {
          authorId: true,
          settingsId: true,
        },
      },
    },
  });
  if (!report || !report.sourceTemplate) {
    return { started: false, status: "failed" };
  }
  if (report.status !== "submitted" && report.status !== "shared") {
    return { started: false, status: "failed" };
  }

  const content = normalizeReportContent(report.content);
  const existing = content.keyPointExtraction;
  if (
    !input.force &&
    existing &&
    (existing.status === "generating" || existing.status === "ready")
  ) {
    return { started: false, status: existing.status };
  }

  const leaderUserId = report.sourceTemplate.authorId;
  const promptState = await loadPersonalPromptForLeader(db, {
    workspaceId: input.workspaceId,
    leaderUserId,
    settingsId: report.sourceTemplate.settingsId,
  });
  const promptSnapshot = promptState.text.trim() || DEFAULT_PERSONAL_KEY_POINT_PROMPT;

  const assistant = await ensureWeeklyReportAssistant(db, {
    workspaceId: input.workspaceId,
    userId: leaderUserId,
  });
  const agent = await db.agent.findUnique({
    where: { id_workspaceId: { id: assistant.agentId, workspaceId: input.workspaceId } },
    select: { computerId: true, runtimeConfig: true },
  });
  if (!agent || !isWeeklyReportAssistantReady(agent)) {
    await writeKeyPointExtraction(db, {
      reportId: report.id,
      content,
      extraction: {
        status: "pending_setup",
        promptSnapshot,
        error: "weekly_report_assistant_not_configured",
      },
    });
    return { started: false, status: "pending_setup" };
  }

  await writeKeyPointExtraction(db, {
    reportId: report.id,
    content,
    extraction: { status: "generating", promptSnapshot },
  });

  const authorDisplayName = report.author.displayName?.trim() || report.author.username;
  const wakeBody = buildPersonalKeyPointWakeText({
    reportId: report.id,
    prompt: promptSnapshot,
    authorDisplayName,
    year: report.cycle.year,
    week: report.cycle.week,
  });

  const ensured = await ensureWeeklyReportAssistantChatSession(db, {
    workspaceId: input.workspaceId,
    userId: leaderUserId,
    subjectType: "report",
    subjectId: report.id,
  });
  const sessionId = ensured.activeSessionId;

  if (input.wake) {
    await input.wake({
      workspaceId: input.workspaceId,
      leaderUserId,
      reportId: report.id,
      sessionId,
      body: wakeBody,
    });
  } else {
    await wakeLeaderKeyPointAssistant(db, {
      workspaceId: input.workspaceId,
      leaderUserId,
      reportId: report.id,
      sessionId,
      body: wakeBody,
    });
  }

  return { started: true, status: "generating" };
}

async function loadPersonalPromptForLeader(
  db: PrismaClient,
  input: { workspaceId: string; leaderUserId: string; settingsId: string | null },
): Promise<KeyPointPromptState> {
  if (!input.settingsId) {
    return emptyKeyPointPrompts().personal;
  }
  const format = await db.weeklyReport.findFirst({
    where: {
      workspaceId: input.workspaceId,
      authorId: input.leaderUserId,
      kind: "template",
      settingsId: input.settingsId,
      submissions: { none: { kind: "member" } },
    },
    orderBy: { updatedAt: "desc" },
    select: { content: true },
  });
  if (!format) return emptyKeyPointPrompts().personal;
  return resolvePersonalPromptFromFormat(normalizeReportContent(format.content));
}

async function wakeLeaderKeyPointAssistant(
  db: PrismaClient,
  input: {
    workspaceId: string;
    leaderUserId: string;
    reportId: string;
    sessionId: string;
    body: string;
  },
) {
  const centrifugo = createCentrifugoServerApi();
  const chat = new WeeklyReportAssistantChat(
    db,
    new PrismaDirectConversationRepository(db),
    getMessageRequestIdempotency(),
    centrifugo,
    new CentrifugoConversationRealtime(centrifugo),
  );
  await chat.postRequest({
    workspaceId: input.workspaceId,
    userId: input.leaderUserId,
    requestId: crypto.randomUUID(),
    subjectType: "report",
    subjectId: input.reportId,
    sessionId: input.sessionId,
    platformTurn: true,
    body: input.body,
  });
}

/**
 * Leader weekly-report assistant writes personal key-point markdown.
 * Authorization: agent must be the Leader's WeeklyReportAssistant, and the
 * report must be a member submission whose source template the Leader owns.
 */
export async function applyPersonalKeyPointExtraction(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    reportId: string;
    markdown: string;
    requestId: string;
  },
): Promise<{ status: "ready"; reportId: string }> {
  const markdown = input.markdown.trim();
  if (!markdown) throw new AppError("INVALID_INPUT");

  const owner = await db.weeklyReportAssistant.findFirst({
    where: { workspaceId: input.workspaceId, agentId: input.agentId },
    select: { userId: true },
  });
  if (!owner) throw new AppError("ACCESS_DENIED");

  const report = await db.weeklyReport.findFirst({
    where: {
      id: input.reportId,
      workspaceId: input.workspaceId,
      kind: "member",
    },
    select: {
      id: true,
      content: true,
      sourceTemplate: { select: { authorId: true } },
    },
  });
  if (!report?.sourceTemplate) throw new AppError("NOT_FOUND");
  if (report.sourceTemplate.authorId !== owner.userId) throw new AppError("ACCESS_DENIED");

  const content = normalizeReportContent(report.content);
  const promptSnapshot =
    content.keyPointExtraction?.promptSnapshot ?? DEFAULT_PERSONAL_KEY_POINT_PROMPT;
  await writeKeyPointExtraction(db, {
    reportId: report.id,
    content,
    extraction: {
      status: "ready",
      promptSnapshot,
      markdown,
      generatedAt: new Date().toISOString(),
    },
  });
  return { status: "ready", reportId: report.id };
}

export function mergeKeyPointPromptSlot(
  prompts: KeyPointPromptsMeta,
  slot: "team" | "personal",
  text: string,
  now = new Date(),
): KeyPointPromptsMeta {
  return {
    ...prompts,
    [slot]: applyKeyPointPromptText(prompts[slot], text, now),
  };
}
