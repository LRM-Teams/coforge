import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
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
    if (!agent || agent.computerId !== computerId || !collectorRuntimeConfigured(agent.runtimeConfig)) {
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

export async function getCollectRun(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; runId: string },
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
  return toRunView(run);
}
