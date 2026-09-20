import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { createCentrifugoServerApi } from "../centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "../conversations/conversation-realtime.server";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import { getMessageRequestIdempotency } from "../conversations/redis-message-request-idempotency.server";
import { SendDirectMessage } from "../conversations/direct-message.server";
import { parseAgentRuntimeConfig } from "../agents/agent-runtime-config.server";
import {
  DEFAULT_PERSONAL_KEY_POINT_PROMPT,
  DEFAULT_TEAM_KEY_POINT_PROMPT,
  normalizeReportContent,
  withKeyPointExtraction,
  type KeyPointExtractionMeta,
  type KeyPointPromptState,
  type KeyPointPromptsMeta,
  type ReportContent,
  applyKeyPointPromptText,
  emptyKeyPointPrompts,
} from "../../features/records/records-content";
import { linkifyKeyPointSourceAttributions } from "../../features/records/key-point-source-links";
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

export function buildTeamKeyPointWakeText(input: {
  overviewReportId: string;
  prompt: string;
  year: number;
  week: number;
  submitted: ReadonlyArray<{ reportId: string; displayName: string }>;
}): string {
  const memberLines =
    input.submitted.length === 0
      ? ["(本周尚无已提交成员周报)"]
      : input.submitted.map((row) => `- ${row.displayName} — reportId: ${row.reportId}`);
  const attributionExample =
    input.submitted[0] != null
      ? `- 完成模板拖拽 [@${input.submitted[0].displayName}](/records/${input.submitted[0].reportId})`
      : "- 完成模板拖拽 [@显示名](/records/<reportId>)";
  return [
    "[weekly-report-team-key-points]",
    `overviewReportId: ${input.overviewReportId}`,
    `week: ${input.year} W${input.week}`,
    "",
    "平台已触发「全员要点提炼」。请按下列提示词阅读本周所有已提交成员周报，整理成一份团队要点纪要，",
    "然后通过 `coforge weekly-report-key-points submit --report-id <overviewReportId> --request-id <uuid> --markdown <file>`",
    "写回 markdown（reportId 使用 overviewReportId；不要用 body-edit Confirm）。",
    "",
    "## 已提交成员",
    ...memberLines,
    "",
    "## 来源标注（必须）",
    "每条要点末尾必须附上来源成员的 Markdown 链接；链接文字以 @ 开头，href 使用上表 reportId：",
    attributionExample,
    "同一事项多名成员则并列多个 [@姓名](/records/<reportId>)；不要只写姓名而不带链接。",
    "",
    "## 提示词",
    input.prompt.trim() || DEFAULT_TEAM_KEY_POINT_PROMPT,
  ].join("\n");
}

export async function resolvePersonalPromptFromFormat(
  content: ReportContent,
): Promise<KeyPointPromptState> {
  const prompts = content.keyPointPrompts ?? emptyKeyPointPrompts();
  return prompts.personal;
}

export async function resolveTeamPromptFromFormat(
  content: ReportContent,
): Promise<KeyPointPromptState> {
  const prompts = content.keyPointPrompts ?? emptyKeyPointPrompts();
  return prompts.team;
}

/** Persist extraction meta onto a report (member personal or overview team). */
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
  const promptState = await loadPromptForLeader(db, {
    workspaceId: input.workspaceId,
    leaderUserId,
    settingsId: report.sourceTemplate.settingsId,
    slot: "personal",
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

/**
 * Leader manually starts team key-point extraction for one overview week parent.
 * Idempotent when already generating/ready unless force=true.
 */
export async function startTeamKeyPointExtraction(
  db: PrismaClient,
  input: {
    workspaceId: string;
    overviewReportId: string;
    force?: boolean;
    /**
     * `side-chat-confirm`: Agent submit parks markdown for side-chat Insert
     * instead of writing `ready` immediately. Requires confirmSessionId.
     */
    delivery?: "side-chat-confirm";
    confirmSessionId?: string;
    wake?: (args: {
      workspaceId: string;
      leaderUserId: string;
      reportId: string;
      sessionId: string;
      body: string;
    }) => Promise<void>;
  },
): Promise<{ started: boolean; status: KeyPointExtractionMeta["status"] }> {
  const overview = await db.weeklyReport.findFirst({
    where: {
      id: input.overviewReportId,
      workspaceId: input.workspaceId,
      kind: "template",
    },
    select: {
      id: true,
      content: true,
      authorId: true,
      settingsId: true,
      cycle: { select: { year: true, week: true } },
    },
  });
  if (!overview) return { started: false, status: "failed" };

  const content = normalizeReportContent(overview.content);
  const existing = content.keyPointExtraction;
  if (
    !input.force &&
    existing &&
    (existing.status === "generating" || existing.status === "ready")
  ) {
    return { started: false, status: existing.status };
  }

  const assignmentCount = await db.weeklyReport.count({
    where: {
      workspaceId: input.workspaceId,
      sourceTemplateId: overview.id,
      kind: "member",
    },
  });
  // Live format documents have no member assignments; only overview parents do.
  if (assignmentCount === 0) return { started: false, status: "failed" };

  const submitted = await db.weeklyReport.findMany({
    where: {
      workspaceId: input.workspaceId,
      sourceTemplateId: overview.id,
      kind: "member",
      status: { in: ["submitted", "shared"] },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      author: { select: { username: true, displayName: true } },
    },
  });

  const leaderUserId = overview.authorId;
  const promptState = await loadPromptForLeader(db, {
    workspaceId: input.workspaceId,
    leaderUserId,
    settingsId: overview.settingsId,
    slot: "team",
  });
  const promptSnapshot = promptState.text.trim() || DEFAULT_TEAM_KEY_POINT_PROMPT;

  if (submitted.length === 0) {
    await writeKeyPointExtraction(db, {
      reportId: overview.id,
      content,
      extraction: {
        status: "failed",
        promptSnapshot,
        error: "no_submitted_member_reports",
      },
    });
    return { started: false, status: "failed" };
  }

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
      reportId: overview.id,
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
    reportId: overview.id,
    content,
    extraction: {
      status: "generating",
      promptSnapshot,
      // Keep the last confirmed body on the page until Insert replaces it.
      ...(existing?.markdown ? { markdown: existing.markdown } : {}),
      ...(input.delivery === "side-chat-confirm" && input.confirmSessionId
        ? {
            delivery: "side-chat-confirm" as const,
            confirmSessionId: input.confirmSessionId,
          }
        : {}),
    },
  });

  const wakeBody = buildTeamKeyPointWakeText({
    overviewReportId: overview.id,
    prompt: promptSnapshot,
    year: overview.cycle.year,
    week: overview.cycle.week,
    submitted: submitted.map((row) => ({
      reportId: row.id,
      displayName: row.author.displayName?.trim() || row.author.username,
    })),
  });

  const ensured = await ensureWeeklyReportAssistantChatSession(db, {
    workspaceId: input.workspaceId,
    userId: leaderUserId,
    subjectType: "report",
    subjectId: overview.id,
  });
  const sessionId =
    input.delivery === "side-chat-confirm" && input.confirmSessionId
      ? input.confirmSessionId
      : ensured.activeSessionId;

  if (input.wake) {
    await input.wake({
      workspaceId: input.workspaceId,
      leaderUserId,
      reportId: overview.id,
      sessionId,
      body: wakeBody,
    });
  } else {
    await wakeLeaderKeyPointAssistant(db, {
      workspaceId: input.workspaceId,
      leaderUserId,
      reportId: overview.id,
      sessionId,
      body: wakeBody,
    });
  }

  return { started: true, status: "generating" };
}

async function loadPromptForLeader(
  db: PrismaClient,
  input: {
    workspaceId: string;
    leaderUserId: string;
    settingsId: string | null;
    slot: "team" | "personal";
  },
): Promise<KeyPointPromptState> {
  if (!input.settingsId) {
    return emptyKeyPointPrompts()[input.slot];
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
  if (!format) return emptyKeyPointPrompts()[input.slot];
  const content = normalizeReportContent(format.content);
  return input.slot === "team"
    ? resolveTeamPromptFromFormat(content)
    : resolvePersonalPromptFromFormat(content);
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

/**
 * Leader weekly-report assistant writes team key-point markdown onto the
 * overview template (week parent). reportId is the overview template id.
 */
export async function applyTeamKeyPointExtraction(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    reportId: string;
    markdown: string;
    requestId: string;
  },
): Promise<{ status: "ready" | "awaiting_confirm"; reportId: string }> {
  const rawMarkdown = input.markdown.trim();
  if (!rawMarkdown) throw new AppError("INVALID_INPUT");

  const owner = await db.weeklyReportAssistant.findFirst({
    where: { workspaceId: input.workspaceId, agentId: input.agentId },
    select: { userId: true },
  });
  if (!owner) throw new AppError("ACCESS_DENIED");

  const report = await db.weeklyReport.findFirst({
    where: {
      id: input.reportId,
      workspaceId: input.workspaceId,
      kind: "template",
    },
    select: {
      id: true,
      content: true,
      authorId: true,
    },
  });
  if (!report) throw new AppError("NOT_FOUND");
  if (report.authorId !== owner.userId) throw new AppError("ACCESS_DENIED");

  const assignmentCount = await db.weeklyReport.count({
    where: {
      workspaceId: input.workspaceId,
      sourceTemplateId: report.id,
      kind: "member",
    },
  });
  if (assignmentCount === 0) throw new AppError("NOT_FOUND");

  const sources = await loadSubmittedTeamKeyPointSources(db, {
    workspaceId: input.workspaceId,
    overviewReportId: report.id,
  });
  const markdown = linkifyTeamKeyPointMarkdown(rawMarkdown, sources, report.id);

  const content = normalizeReportContent(report.content);
  const promptSnapshot =
    content.keyPointExtraction?.promptSnapshot ?? DEFAULT_TEAM_KEY_POINT_PROMPT;
  const confirmSessionId = content.keyPointExtraction?.confirmSessionId;
  if (content.keyPointExtraction?.delivery === "side-chat-confirm" && confirmSessionId) {
    const publishedMarkdown = content.keyPointExtraction.markdown;
    await writeKeyPointExtraction(db, {
      reportId: report.id,
      content,
      extraction: {
        status: "awaiting_confirm",
        promptSnapshot,
        // Page body stays on the previous published markdown until Insert.
        ...(publishedMarkdown ? { markdown: publishedMarkdown } : {}),
        pendingMarkdown: markdown,
        generatedAt: new Date().toISOString(),
        delivery: "side-chat-confirm",
        confirmSessionId,
      },
    });
    await postTeamKeyPointConfirmSuggestion(db, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      leaderUserId: owner.userId,
      overviewReportId: report.id,
      sessionId: confirmSessionId,
      markdown,
    });
    return { status: "awaiting_confirm", reportId: report.id };
  }

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

/** Submitted member reports used for @source linkification on team key points. */
export async function loadSubmittedTeamKeyPointSources(
  db: PrismaClient,
  input: { workspaceId: string; overviewReportId: string },
): Promise<Array<{ reportId: string; displayName: string }>> {
  const submitted = await db.weeklyReport.findMany({
    where: {
      workspaceId: input.workspaceId,
      sourceTemplateId: input.overviewReportId,
      kind: "member",
      status: { in: ["submitted", "shared"] },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      author: { select: { username: true, displayName: true } },
    },
  });
  return submitted.map((row) => ({
    reportId: row.id,
    displayName: row.author.displayName?.trim() || row.author.username,
  }));
}

export function linkifyTeamKeyPointMarkdown(
  markdown: string,
  sources: ReadonlyArray<{ reportId: string; displayName: string }>,
  overviewReportId: string,
): string {
  return linkifyKeyPointSourceAttributions(markdown, sources, `/records/${overviewReportId}`);
}

async function postTeamKeyPointConfirmSuggestion(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    leaderUserId: string;
    overviewReportId: string;
    sessionId: string;
    markdown: string;
  },
) {
  const { buildWeeklyReportAssistantSuggestionBody } =
    await import("./weekly-report-assistant-suggestion.server");
  const leader = await db.user.findUnique({
    where: { id: input.leaderUserId },
    select: { username: true },
  });
  if (!leader?.username) return;

  const body = buildWeeklyReportAssistantSuggestionBody({
    displayText: "已整理好全员要点，请确认后插入。",
    suggestion: {
      type: "key-point-edit",
      reportId: input.overviewReportId,
      summary: "全员要点草稿",
      markdown: input.markdown,
    },
  });

  const centrifugo = createCentrifugoServerApi();
  const conversations = new PrismaDirectConversationRepository(db);
  const sender = new SendDirectMessage(
    conversations,
    getMessageRequestIdempotency(),
    centrifugo,
    new CentrifugoConversationRealtime(centrifugo),
  );
  await sender.executeFromAgent({
    requestId: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    target: `@${leader.username}`,
    body,
  });
}

/** HTTPS write-back entry: dispatch personal vs team by report kind. */
export async function applyKeyPointExtractionWriteBack(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    reportId: string;
    markdown: string;
    requestId: string;
  },
): Promise<{ status: "ready" | "awaiting_confirm"; reportId: string }> {
  const report = await db.weeklyReport.findFirst({
    where: { id: input.reportId, workspaceId: input.workspaceId },
    select: { kind: true },
  });
  if (!report) throw new AppError("NOT_FOUND");
  if (report.kind === "member") return applyPersonalKeyPointExtraction(db, input);
  if (report.kind === "template") return applyTeamKeyPointExtraction(db, input);
  throw new AppError("INVALID_INPUT");
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
