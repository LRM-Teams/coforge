import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  ensureCollector,
  listOwnedComputerSlots,
  type CollectorComputerSlot,
} from "./weekly-report-collector.server";
import {
  acceptCollectSlotReport,
  canSynthesizeFromSlots,
  COLLECT_RUN_STATUS,
  failRunningCollectSlotsForAgent,
  getCollectRunWithPacks,
  startCollectRun,
  type AcceptCollectSlotReportResult,
  type CollectRunComputerInput,
  type CollectWindowKind,
} from "./weekly-report-collect-run.server";
import { resolveCollectWindow } from "#src/features/records/weekly-report-collect-window";
import { RecordCatalog } from "./record-catalog.server";
import { resolveLatestChatSessionId } from "./weekly-report-assistant-chat-session.server";

/** Wake text for a per-Computer collector Agent (ADR 0032). */
export function buildCollectorWakeBody(input: {
  runId: string;
  reportId: string;
  slotId: string;
  windowStart: Date;
  windowEnd: Date;
  scanPaths: string[];
  ownerUsername: string;
  ownerDisplayName?: string | null;
  ownerGitHubLogin?: string | null;
}): string {
  const paths =
    input.scanPaths.length > 0
      ? input.scanPaths.map((path) => `- ${path}`).join("\n")
      : "- (use Computer-local collect-roots or heuristic SCAN_ROOTS)";
  const ownerLines = [
    `ownerUsername=${input.ownerUsername}`,
    ...(input.ownerDisplayName?.trim()
      ? [`ownerDisplayName=${input.ownerDisplayName.trim()}`]
      : []),
    ...(input.ownerGitHubLogin?.trim()
      ? [`ownerGitHubLogin=${input.ownerGitHubLogin.trim()}`]
      : []),
  ];
  return [
    "请在本机按 weekly-report-collect skill 采集工作证据，完成后用 coforge 上报 pack。",
    "只采集本报告作者本人的工作；git 等平台必须按作者过滤，不要把同事的提交一并采入。",
    `runId=${input.runId}`,
    `reportId=${input.reportId}`,
    `slotId=${input.slotId}`,
    `windowStart=${input.windowStart.toISOString()}`,
    `windowEnd=${input.windowEnd.toISOString()}`,
    ...ownerLines,
    "scanPaths:",
    paths,
    "",
    "完成后调用：coforge weekly-report-collect submit-pack --run-id <runId> --request-id <uuid> --markdown <file>",
    "无证据：coforge weekly-report-collect submit-empty --run-id <runId> --request-id <uuid>",
    "失败：coforge weekly-report-collect submit-failure --run-id <runId> --request-id <uuid> --reason <text>",
  ].join("\n");
}

/** Platform→WeeklyReportAssistant synthesizer turn (ADR 0032 §6). */
export function buildCollectSynthesizerWakeText(input: {
  reportId: string;
  runId: string;
  slots: Array<{
    computerLabel: string;
    status: string;
    packMarkdown: string | null;
    failureReason: string | null;
  }>;
  /** Side-chat revision notes (e.g. 「更概括一些」) for a re-synthesize. */
  userGuidance?: string | null;
}): string {
  const board = input.slots
    .map((slot) => {
      const detail =
        slot.status === "ready"
          ? "ready"
          : slot.failureReason
            ? `${slot.status}: ${slot.failureReason}`
            : slot.status;
      return `- ${slot.computerLabel}: ${detail}`;
    })
    .join("\n");
  const packs = input.slots
    .filter((slot) => slot.status === "ready" && slot.packMarkdown)
    .map((slot) => `### Pack · ${slot.computerLabel}\n\n${slot.packMarkdown!.trim()}`)
    .join("\n\n");
  const guidance = input.userGuidance?.trim();
  return [
    "采集已全部结束。请根据老板周报模板结构和下列采集包，整理成当前成员周报草稿。",
    "采集包应已按作者过滤；草稿只写该成员本人工作，不要扩写同事贡献。",
    "用 coforge weekly-report context / read 读取模板与当前报告结构；不要重新采集本机文件。",
    "在回复末尾附上 [weekly-report-suggestion] body-edit（reportId 如下），供用户 Confirm 写入。",
    `reportId=${input.reportId}`,
    `runId=${input.runId}`,
    ...(guidance ? ["", "## 用户调整要求", "请按下列要求重写草稿（不要忽略）：", guidance] : []),
    "",
    "## 槽位状态",
    board,
    "",
    "## 可用采集包",
    packs || "(无)",
  ].join("\n");
}

/** Lists owned Computer collector slots for the plan card. */
export async function loadCollectPlanSlots(
  db: PrismaClient,
  input: { workspaceId: string; userId: string },
): Promise<CollectorComputerSlot[]> {
  return listOwnedComputerSlots(db, input);
}

export async function ensureCollectPlanCollector(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; computerId: string },
) {
  return ensureCollector(db, input);
}

/**
 * Submits the E2 plan: start Collect Run, wake each collector Agent via DM,
 * and post a side-chat collect-run card.
 */
export async function submitWeeklyReportCollectPlan(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    windowKind: CollectWindowKind;
    year?: number;
    week?: number;
    month?: number;
    quarter?: number;
    customStart?: string;
    customEnd?: string;
    computers: CollectRunComputerInput[];
  },
) {
  let windowStart: Date;
  let windowEnd: Date;
  let label: string;
  try {
    const resolved = resolveCollectWindow({
      kind: input.windowKind,
      year: input.year,
      week: input.week,
      month: input.month,
      quarter: input.quarter,
      customStart: input.customStart,
      customEnd: input.customEnd,
    });
    windowStart = resolved.windowStart;
    windowEnd = resolved.windowEnd;
    label = resolved.label;
  } catch {
    throw new AppError("INVALID_INPUT");
  }

  const run = await startCollectRun(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    reportId: input.reportId,
    windowKind: input.windowKind,
    windowStart,
    windowEnd,
    computers: input.computers,
  });

  const conversations = new PrismaDirectConversationRepository(db);
  const centrifugo = createCentrifugoServerApi();
  const idempotency = getMessageRequestIdempotency();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  const sender = new SendDirectMessage(conversations, idempotency, centrifugo, realtime);

  const detailed = await getCollectRunWithPacks(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    runId: run.id,
  });

  const owner = await db.user.findUnique({
    where: { id: input.userId },
    select: {
      username: true,
      displayName: true,
      gitHubConnection: { select: { login: true } },
    },
  });
  if (!owner) throw new AppError("NOT_FOUND");

  for (const slot of detailed.slots) {
    const opened = await conversations.memberForUser(
      input.workspaceId,
      input.userId,
      slot.collectorAgentId,
    );
    await sender.execute({
      requestId: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: input.userId,
      body: buildCollectorWakeBody({
        runId: run.id,
        reportId: input.reportId,
        slotId: slot.id,
        windowStart,
        windowEnd,
        scanPaths: slot.scanPaths,
        ownerUsername: owner.username,
        ownerDisplayName: owner.displayName,
        ownerGitHubLogin: owner.gitHubConnection?.login ?? null,
      }),
    });
  }

  const catalog = new RecordCatalog(db);
  await catalog.postAssistantCollectComment({
    workspaceId: input.workspaceId,
    userId: input.userId,
    subjectType: "report",
    subjectId: input.reportId,
    body: `已开始采集（${label}）。各采集 Agent 正在对应电脑上工作；完成后可在下方展开查看采集包。`,
    payload: { kind: "collect-run", runId: run.id },
  });

  return detailed;
}

/**
 * Agent HTTPS settle path: accept pack/failure, post plain progress text (no
 * second collect-run card), and wake the WeeklyReportAssistant when synthesis
 * can start.
 */
export async function reportCollectSlotOutcome(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    computerId: string;
    requestId: string;
    runId: string;
    outcome: "ready" | "empty" | "failed";
    packMarkdown?: string;
    failureReason?: string;
  },
): Promise<AcceptCollectSlotReportResult> {
  const accepted = await acceptCollectSlotReport(db, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    requestId: input.requestId,
    runId: input.runId,
    outcome: input.outcome,
    packMarkdown: input.packMarkdown,
    failureReason: input.failureReason,
  });

  if (!accepted.newlyAccepted) return accepted;

  const runMeta = await db.weeklyReportCollectRun.findFirst({
    where: { id: input.runId, workspaceId: input.workspaceId },
    select: { reportId: true, userId: true },
  });
  if (!runMeta) return accepted;

  const catalog = new RecordCatalog(db);
  const computer = await db.computer.findFirst({
    where: { id: input.computerId },
    select: { displayName: true, name: true },
  });
  const label = computer?.displayName || computer?.name || input.computerId;

  if (accepted.synthesisStarted) {
    // One user-visible progress line: collect→synthesize handoff. Per-slot
    // "已就绪" is redundant when this accept already finishes the wave.
    await catalog.postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: "采集已完成，正在整理周报草稿，请稍候确认。",
    });
    await wakeCollectSynthesizer(db, {
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      reportId: runMeta.reportId,
      runId: input.runId,
    });
  } else if (accepted.waveExhausted || (accepted.run.allTerminal && !accepted.run.canSynthesize)) {
    await catalog.postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: "采集结束，但没有可用的采集包，无法生成周报草稿。请检查采集 Agent 的模型配置后重新提交采集计划。",
    });
  } else if (input.outcome === "ready") {
    await catalog.postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: `采集包 · ${label} 已就绪。`,
    });
  } else if (input.outcome === "empty") {
    await catalog.postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: `采集 · ${label} 未找到可用证据。`,
    });
  } else {
    await catalog.postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: `采集 · ${label} 失败${input.failureReason ? `：${input.failureReason}` : "。"}`,
    });
  }

  return accepted;
}

/**
 * When a collector turn fails before HTTPS submit (model 405, crash, …), mark
 * every still-running slot for that Agent failed and post the same side-chat
 * progress lines as an explicit submit-failure.
 */
export async function reportCollectorRuntimeFailure(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    computerId: string;
    requestId: string;
    failureReason: string;
  },
): Promise<{ accepted: AcceptCollectSlotReportResult[]; slotCount: number }> {
  const failed = await failRunningCollectSlotsForAgent(db, input);
  if (failed.slotCount === 0) return failed;

  const catalog = new RecordCatalog(db);
  const computer = await db.computer.findFirst({
    where: { id: input.computerId },
    select: { displayName: true, name: true },
  });
  const label = computer?.displayName || computer?.name || input.computerId;
  const reason = input.failureReason.trim() || "collector runtime failed";

  for (const accepted of failed.accepted) {
    if (!accepted.newlyAccepted) continue;
    const runMeta = await db.weeklyReportCollectRun.findFirst({
      where: { id: accepted.run.id, workspaceId: input.workspaceId },
      select: { reportId: true, userId: true },
    });
    if (!runMeta) continue;
    if (accepted.synthesisStarted) {
      await catalog.postAssistantCollectComment({
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        subjectType: "report",
        subjectId: runMeta.reportId,
        body: "采集已完成，正在整理周报草稿，请稍候确认。",
      });
      await wakeCollectSynthesizer(db, {
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        reportId: runMeta.reportId,
        runId: accepted.run.id,
      });
    } else if (accepted.waveExhausted) {
      await catalog.postAssistantCollectComment({
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        subjectType: "report",
        subjectId: runMeta.reportId,
        body: "采集结束，但没有可用的采集包，无法生成周报草稿。请检查采集 Agent 的模型配置后重新提交采集计划。",
      });
    } else {
      await catalog.postAssistantCollectComment({
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        subjectType: "report",
        subjectId: runMeta.reportId,
        body: `采集 · ${label} 失败：${reason}`,
      });
    }
  }

  return failed;
}

async function wakeCollectSynthesizer(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    runId: string;
    sessionId?: string | null;
    userGuidance?: string | null;
  },
) {
  const detailed = await getCollectRunWithPacks(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    runId: input.runId,
  });
  const sessionId =
    input.sessionId ??
    (await resolveLatestChatSessionId(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
    }));
  const { openWeeklyReportAssistantChat } = await import("./weekly-report-assistant-chat.server");
  const chat = openWeeklyReportAssistantChat(db);
  await chat.postRequest({
    workspaceId: input.workspaceId,
    userId: input.userId,
    requestId: crypto.randomUUID(),
    subjectType: "report",
    subjectId: input.reportId,
    sessionId,
    platformTurn: true,
    body: buildCollectSynthesizerWakeText({
      reportId: input.reportId,
      runId: input.runId,
      userGuidance: input.userGuidance,
      slots: detailed.slots.map((slot) => ({
        computerLabel: slot.computerLabel,
        status: slot.status,
        packMarkdown: slot.packMarkdown,
        failureReason: slot.failureReason,
      })),
    }),
  });
}

/**
 * Side-chat 「整理周报」: wake the WeeklyReportAssistant from the latest ready
 * Collect Run packs without starting a new harvest.
 */
export async function requestWeeklyReportSynthesis(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    sessionId?: string | null;
    userGuidance?: string | null;
  },
): Promise<{ ok: true; runId: string } | { ok: false; reason: "no_packs" }> {
  const runs = await db.weeklyReportCollectRun.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.reportId,
    },
    orderBy: { createdAt: "desc" },
    include: { slots: true },
    take: 10,
  });
  const usable = runs.find((run) => canSynthesizeFromSlots(run.slots));
  if (!usable) return { ok: false, reason: "no_packs" };

  await db.weeklyReportCollectRun.update({
    where: { id: usable.id },
    data: { status: COLLECT_RUN_STATUS.synthesizing },
  });
  await wakeCollectSynthesizer(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    reportId: input.reportId,
    runId: usable.id,
    sessionId: input.sessionId,
    userGuidance: input.userGuidance,
  });
  return { ok: true, runId: usable.id };
}
