import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { createHash } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { collectorRuntimeConfigured } from "./weekly-report-collector.server";

export const COLLECT_RUN_STATUS = {
  collecting: "collecting",
  synthesizing: "synthesizing",
  awaiting_confirm: "awaiting_confirm",
  done: "done",
  cancelled: "cancelled",
} as const;

export const COLLECT_SLOT_STATUS = {
  running: "running",
  ready: "ready",
  failed: "failed",
  empty: "empty",
  stalled: "stalled",
  cancelled: "cancelled",
} as const;

/** ADR 0032 platform settle ceiling for one collect wave. */
export const COLLECT_SLOT_STALL_MS = 15 * 60_000;

export const COLLECT_SLOT_STALL_REASON =
  "采集超时：采集 Agent 在限定时间内未上报结果（常见原因：模型接口失败或进程异常）。";

export type CollectWindowKind = "week" | "month" | "quarter" | "year" | "custom";

export type CollectRunComputerInput = {
  computerId: string;
  /** Snapshot for this run; empty means the collector uses Computer-local roots / heuristics. */
  scanPaths: string[];
};

export type CollectRunSlotView = {
  id: string;
  computerId: string;
  collectorAgentId: string;
  scanPaths: string[];
  status: string;
  retryCount: number;
  failureReason: string | null;
  hasPack: boolean;
};

export type CollectRunView = {
  id: string;
  reportId: string;
  status: string;
  windowKind: string;
  windowStart: Date;
  windowEnd: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  slots: CollectRunSlotView[];
  allTerminal: boolean;
  canSynthesize: boolean;
};

const TERMINAL_SLOT_STATUSES = new Set<string>([
  COLLECT_SLOT_STATUS.ready,
  COLLECT_SLOT_STATUS.failed,
  COLLECT_SLOT_STATUS.empty,
  COLLECT_SLOT_STATUS.stalled,
  COLLECT_SLOT_STATUS.cancelled,
]);

export function allSlotsTerminal(slots: Array<{ status: string }>): boolean {
  return slots.every((slot) => TERMINAL_SLOT_STATUSES.has(slot.status));
}

/** ADR 0032: synthesize only when every slot is terminal and at least one is ready. */
export function canSynthesizeFromSlots(slots: Array<{ status: string }>): boolean {
  if (!allSlotsTerminal(slots) || slots.length === 0) return false;
  return slots.some((slot) => slot.status === COLLECT_SLOT_STATUS.ready);
}

/** Wave finished with no usable pack — run must leave `collecting` so the UI can stop. */
export function collectWaveExhausted(slots: Array<{ status: string }>): boolean {
  return slots.length > 0 && allSlotsTerminal(slots) && !canSynthesizeFromSlots(slots);
}

export function isRetryableSlotStatus(status: string): boolean {
  return status === COLLECT_SLOT_STATUS.failed || status === COLLECT_SLOT_STATUS.stalled;
}

function asScanPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function toRunView(run: {
  id: string;
  reportId: string;
  status: string;
  windowKind: string;
  windowStart: Date;
  windowEnd: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  slots: Array<{
    id: string;
    computerId: string;
    collectorAgentId: string;
    scanPaths: unknown;
    status: string;
    retryCount: number;
    failureReason: string | null;
    packMarkdown: string | null;
  }>;
}): CollectRunView {
  const slots = run.slots.map((slot) => ({
    id: slot.id,
    computerId: slot.computerId,
    collectorAgentId: slot.collectorAgentId,
    scanPaths: asScanPaths(slot.scanPaths),
    status: slot.status,
    retryCount: slot.retryCount,
    failureReason: slot.failureReason,
    hasPack: Boolean(slot.packMarkdown && slot.packMarkdown.length > 0),
  }));
  return {
    id: run.id,
    reportId: run.reportId,
    status: run.status,
    windowKind: run.windowKind,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    slots,
    allTerminal: allSlotsTerminal(slots),
    canSynthesize: canSynthesizeFromSlots(slots),
  };
}

/**
 * Starts a Collect Run for the member report. Only Computers the User owns,
 * with a ready collector binding, may be selected.
 */
export async function startCollectRun(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    windowKind: CollectWindowKind;
    windowStart: Date;
    windowEnd: Date;
    computers: CollectRunComputerInput[];
  },
): Promise<CollectRunView> {
  if (input.computers.length === 0) throw new AppError("INVALID_INPUT");
  if (!(input.windowStart instanceof Date) || !(input.windowEnd instanceof Date)) {
    throw new AppError("INVALID_INPUT");
  }
  if (!(input.windowStart.getTime() < input.windowEnd.getTime())) {
    throw new AppError("INVALID_INPUT");
  }

  const report = await db.weeklyReport.findFirst({
    where: {
      id: input.reportId,
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "member",
    },
    select: { id: true },
  });
  if (!report) throw new AppError("NOT_FOUND");

  const computerIds = [...new Set(input.computers.map((row) => row.computerId))];
  if (computerIds.length !== input.computers.length) throw new AppError("INVALID_INPUT");

  const mounted = await db.workspaceComputer.findMany({
    where: {
      workspaceId: input.workspaceId,
      computerId: { in: computerIds },
    },
    select: {
      computerId: true,
      computer: { select: { id: true, ownerId: true } },
    },
  });
  const mountedById = new Map(mounted.map((row) => [row.computerId, row]));
  for (const computerId of computerIds) {
    const row = mountedById.get(computerId);
    if (!row || row.computer.ownerId !== input.userId) throw new AppError("ACCESS_DENIED");
  }

  const bindings = await db.weeklyReportCollectorBinding.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      computerId: { in: computerIds },
    },
  });
  if (bindings.length !== computerIds.length) throw new AppError("INVALID_INPUT");
  const bindingByComputer = new Map(bindings.map((row) => [row.computerId, row]));

  const agents = await db.agent.findMany({
    where: {
      workspaceId: input.workspaceId,
      id: { in: bindings.map((row) => row.collectorAgentId) },
    },
    select: { id: true, computerId: true, runtimeConfig: true },
  });
  const agentById = new Map(agents.map((row) => [row.id, row]));
  for (const computerId of computerIds) {
    const binding = bindingByComputer.get(computerId);
    if (!binding) throw new AppError("INVALID_INPUT");
    const agent = agentById.get(binding.collectorAgentId);
    if (
      !agent ||
      agent.computerId !== computerId ||
      !collectorRuntimeConfigured(agent.runtimeConfig)
    ) {
      throw new AppError("INVALID_INPUT");
    }
  }

  const now = new Date();
  const created = await db.weeklyReportCollectRun.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.reportId,
      status: COLLECT_RUN_STATUS.collecting,
      windowKind: input.windowKind,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      startedAt: now,
      slots: {
        create: input.computers.map((row) => {
          const binding = bindingByComputer.get(row.computerId)!;
          return {
            computerId: row.computerId,
            collectorAgentId: binding.collectorAgentId,
            scanPaths: asScanPaths(row.scanPaths) as Prisma.InputJsonValue,
            status: COLLECT_SLOT_STATUS.running,
            retryCount: 0,
          };
        }),
      },
    },
    include: { slots: true },
  });

  return toRunView(created);
}

export type AcceptCollectSlotReportResult = {
  run: CollectRunView;
  /** False on requestId replay or when the slot was already terminal. */
  newlyAccepted: boolean;
  /** True once when this accept moves the run from collecting into synthesizing. */
  synthesisStarted: boolean;
  /** True once when every slot is terminal with no ready pack and the run leaves collecting. */
  waveExhausted: boolean;
};

/**
 * Accepts a collector pack or terminal failure for one slot (Agent HTTPS).
 * Idempotent on requestId. When every slot is terminal and ≥1 is ready, advances
 * the run from collecting → synthesizing (ADR 0032 settle). When every slot is
 * terminal with no ready pack, advances collecting → cancelled so the UI leaves
 * the endless「采集中」state (e.g. model-provider 405 with submit-failure).
 */
export async function acceptCollectSlotReport(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    runId: string;
    outcome: "ready" | "empty" | "failed";
    packMarkdown?: string;
    failureReason?: string;
  },
): Promise<AcceptCollectSlotReportResult> {
  const existingByRequest = await db.weeklyReportCollectSlot.findFirst({
    where: { requestId: input.requestId },
    include: { run: { include: { slots: true } } },
  });
  if (existingByRequest) {
    if (existingByRequest.run.workspaceId !== input.workspaceId) {
      throw new AppError("ACCESS_DENIED");
    }
    return {
      run: toRunView({
        ...existingByRequest.run,
        slots: existingByRequest.run.slots,
      }),
      newlyAccepted: false,
      synthesisStarted: false,
      waveExhausted: false,
    };
  }

  const run = await db.weeklyReportCollectRun.findFirst({
    where: { id: input.runId, workspaceId: input.workspaceId },
    include: { slots: true },
  });
  if (!run) throw new AppError("NOT_FOUND");
  const slot = run.slots.find((row) => row.collectorAgentId === input.agentId);
  if (!slot) throw new AppError("ACCESS_DENIED");
  if (TERMINAL_SLOT_STATUSES.has(slot.status) && slot.requestId) {
    return {
      run: toRunView(run),
      newlyAccepted: false,
      synthesisStarted: false,
      waveExhausted: false,
    };
  }

  const packMarkdown = input.outcome === "ready" ? (input.packMarkdown ?? "").trim() : null;
  if (input.outcome === "ready" && !packMarkdown) throw new AppError("INVALID_INPUT");

  await db.weeklyReportCollectSlot.update({
    where: { id: slot.id },
    data: {
      status: input.outcome,
      packMarkdown,
      failureReason:
        input.outcome === "failed"
          ? (input.failureReason ?? "collector failed").slice(0, 2000)
          : null,
      requestId: input.requestId,
    },
  });

  let refreshed = await db.weeklyReportCollectRun.findFirstOrThrow({
    where: { id: run.id },
    include: { slots: { orderBy: { computerId: "asc" } } },
  });

  let synthesisStarted = false;
  let waveExhausted = false;
  if (refreshed.status === COLLECT_RUN_STATUS.collecting) {
    if (canSynthesizeFromSlots(refreshed.slots)) {
      const advanced = await db.weeklyReportCollectRun.updateMany({
        where: { id: run.id, status: COLLECT_RUN_STATUS.collecting },
        data: { status: COLLECT_RUN_STATUS.synthesizing },
      });
      synthesisStarted = advanced.count === 1;
    } else if (collectWaveExhausted(refreshed.slots)) {
      const closed = await db.weeklyReportCollectRun.updateMany({
        where: { id: run.id, status: COLLECT_RUN_STATUS.collecting },
        data: { status: COLLECT_RUN_STATUS.cancelled, completedAt: new Date() },
      });
      waveExhausted = closed.count === 1;
    }
    refreshed = await db.weeklyReportCollectRun.findFirstOrThrow({
      where: { id: run.id },
      include: { slots: { orderBy: { computerId: "asc" } } },
    });
  }

  return {
    run: toRunView(refreshed),
    newlyAccepted: true,
    synthesisStarted,
    waveExhausted,
  };
}

/**
 * ADR 0032 safety ceiling: overdue `running` slots become `stalled`, then an
 * empty wave leaves `collecting`. Called from the User-facing load path so the
 * side-chat card can settle without a separate cron.
 */
export async function settleStaleCollectRun(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; runId: string },
  nowMs: number = Date.now(),
): Promise<CollectRunView> {
  const run = await db.weeklyReportCollectRun.findFirst({
    where: {
      id: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    include: { slots: { orderBy: { computerId: "asc" } } },
  });
  if (!run) throw new AppError("NOT_FOUND");
  if (run.status !== COLLECT_RUN_STATUS.collecting || !run.startedAt) return toRunView(run);
  if (nowMs - run.startedAt.getTime() < COLLECT_SLOT_STALL_MS) return toRunView(run);

  const stalled = await db.weeklyReportCollectSlot.updateMany({
    where: { runId: run.id, status: COLLECT_SLOT_STATUS.running },
    data: {
      status: COLLECT_SLOT_STATUS.stalled,
      failureReason: COLLECT_SLOT_STALL_REASON,
    },
  });
  if (stalled.count === 0) {
    // Slots may already be terminal; still close an empty wave left on collecting.
  }

  let refreshed = await db.weeklyReportCollectRun.findFirstOrThrow({
    where: { id: run.id },
    include: { slots: { orderBy: { computerId: "asc" } } },
  });

  if (refreshed.status === COLLECT_RUN_STATUS.collecting) {
    if (canSynthesizeFromSlots(refreshed.slots)) {
      await db.weeklyReportCollectRun.updateMany({
        where: { id: run.id, status: COLLECT_RUN_STATUS.collecting },
        data: { status: COLLECT_RUN_STATUS.synthesizing },
      });
    } else if (collectWaveExhausted(refreshed.slots)) {
      await db.weeklyReportCollectRun.updateMany({
        where: { id: run.id, status: COLLECT_RUN_STATUS.collecting },
        data: { status: COLLECT_RUN_STATUS.cancelled, completedAt: new Date(nowMs) },
      });
    }
    refreshed = await db.weeklyReportCollectRun.findFirstOrThrow({
      where: { id: run.id },
      include: { slots: { orderBy: { computerId: "asc" } } },
    });
  }

  return toRunView(refreshed);
}

/**
 * Platform path when a collector turn fails before HTTPS submit (e.g. model 405).
 * Marks every still-running slot for this Agent failed, then settles each run.
 */
export async function failRunningCollectSlotsForAgent(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    computerId: string;
    requestId: string;
    failureReason: string;
  },
): Promise<{ accepted: AcceptCollectSlotReportResult[]; slotCount: number }> {
  const slots = await db.weeklyReportCollectSlot.findMany({
    where: {
      collectorAgentId: input.agentId,
      status: COLLECT_SLOT_STATUS.running,
      run: {
        workspaceId: input.workspaceId,
        status: COLLECT_RUN_STATUS.collecting,
      },
    },
    select: { id: true, runId: true },
    orderBy: { createdAt: "asc" },
  });
  if (slots.length === 0) return { accepted: [], slotCount: 0 };

  const reason = input.failureReason.slice(0, 2000) || "collector runtime failed";
  const accepted: AcceptCollectSlotReportResult[] = [];
  for (const slot of slots) {
    accepted.push(
      await acceptCollectSlotReport(db, {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        requestId: collectFailRequestId(input.requestId, slot.id),
        runId: slot.runId,
        outcome: "failed",
        failureReason: reason,
      }),
    );
  }
  return { accepted, slotCount: slots.length };
}

/** Stable UUID per (turn request, slot) so Daemon retries remain idempotent. */
export function collectFailRequestId(turnRequestId: string, slotId: string): string {
  const hex = createHash("sha256").update(`${turnRequestId}:${slotId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function getCollectRun(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; runId: string },
): Promise<CollectRunView> {
  return settleStaleCollectRun(db, input);
}

export type CollectRunSlotDetail = CollectRunSlotView & {
  packMarkdown: string | null;
  computerLabel: string;
};

export type CollectRunDetailView = Omit<CollectRunView, "slots"> & {
  slots: CollectRunSlotDetail[];
};

/** Slot view including pack body for the collapsed result UI. */
export async function getCollectRunWithPacks(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; runId: string },
): Promise<CollectRunDetailView> {
  await settleStaleCollectRun(db, input);
  const run = await db.weeklyReportCollectRun.findFirst({
    where: {
      id: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    include: {
      slots: {
        orderBy: { computerId: "asc" },
        include: { computer: { select: { displayName: true, name: true } } },
      },
    },
  });
  if (!run) throw new AppError("NOT_FOUND");
  const base = toRunView(run);
  return {
    ...base,
    slots: run.slots.map((slot) => ({
      id: slot.id,
      computerId: slot.computerId,
      collectorAgentId: slot.collectorAgentId,
      scanPaths: asScanPaths(slot.scanPaths),
      status: slot.status,
      retryCount: slot.retryCount,
      failureReason: slot.failureReason,
      hasPack: Boolean(slot.packMarkdown && slot.packMarkdown.length > 0),
      packMarkdown: slot.packMarkdown,
      computerLabel: slot.computer.displayName || slot.computer.name || slot.computerId,
    })),
  };
}
