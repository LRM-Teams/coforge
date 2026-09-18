import type { PrismaClient } from "../../../generated/client";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AppError } from "../../lib/app-error";
import { enrollGeneralChannel } from "../conversations/public-channels.server";

export const WEEKLY_REPORT_COLLECTOR_DISPLAY_NAME_PREFIX = "采集 · ";

/** Stable Agent name; length stays ≤64 (`weekly-report-collector-` + UUID). */
export function weeklyReportCollectorAgentName(computerId: string): string {
  return `weekly-report-collector-${computerId}`;
}

export function weeklyReportCollectorDisplayName(computerLabel: string): string {
  const label = computerLabel.trim() || "Computer";
  return `${WEEKLY_REPORT_COLLECTOR_DISPLAY_NAME_PREFIX}${label}`;
}

export type WeeklyReportCollectorBindingRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  computerId: string;
  collectorAgentId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CollectorComputerSlot = {
  computerId: string;
  displayName: string;
  hostname: string;
  bindingId: string | null;
  collectorAgentId: string | null;
  computerConfigured: boolean;
  runtimeConfigured: boolean;
  ready: boolean;
};

/** Mirrors weekly-report assistant readiness without pulling the full runtime parser. */
export function collectorRuntimeConfigured(runtimeConfig: unknown): boolean {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return false;
  const config = runtimeConfig as {
    runtime?: unknown;
    provider?: { kind?: unknown; apiKey?: unknown };
  };
  if (typeof config.runtime !== "string" || config.runtime.length === 0) return false;
  if (config.runtime !== "coforge") return true;
  return config.provider?.kind === "coforge" && Boolean(config.provider.apiKey);
}

/**
 * Creates the User's durable Collector Agent for one owned Computer, or returns
 * the existing binding. Paths are not stored here — Computer-local collect-roots
 * remain authoritative (ADR 0032).
 */
export async function ensureCollector(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; computerId: string },
): Promise<WeeklyReportCollectorBindingRecord> {
  const agentName = weeklyReportCollectorAgentName(input.computerId);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.weeklyReportCollectorBinding.findUnique({
        where: {
          workspaceId_userId_computerId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
            computerId: input.computerId,
          },
        },
      });
      if (existing) return existing;

      const mounted = await tx.workspaceComputer.findUnique({
        where: {
          workspaceId_computerId: {
            workspaceId: input.workspaceId,
            computerId: input.computerId,
          },
        },
        select: {
          computerId: true,
          computer: { select: { id: true, ownerId: true, displayName: true, name: true } },
        },
      });
      if (!mounted || mounted.computer.ownerId !== input.userId) {
        throw new AppError("ACCESS_DENIED");
      }

      // Reclaim an orphan Agent left by a previous partial create (unique name).
      const orphan = await tx.agent.findUnique({
        where: {
          workspaceId_name: { workspaceId: input.workspaceId, name: agentName },
        },
        select: { id: true, ownerId: true, computerId: true },
      });
      let agentId = orphan?.id;
      if (orphan) {
        if (orphan.ownerId !== input.userId) throw new AppError("ACCESS_DENIED");
        if (orphan.computerId !== input.computerId) {
          await tx.agent.update({
            where: { id_workspaceId: { id: orphan.id, workspaceId: input.workspaceId } },
            data: { computerId: input.computerId },
          });
        }
      } else {
        const label = mounted.computer.displayName || mounted.computer.name || mounted.computerId;
        const agent = await tx.agent.create({
          data: {
            workspaceId: input.workspaceId,
            ownerId: input.userId,
            computerId: input.computerId,
            name: agentName,
            displayName: weeklyReportCollectorDisplayName(label),
            description: "",
            runtimeConfig: {
              runtime: RUNTIME_PROVIDER.COFORGE,
              provider: { kind: "default" },
              model: "",
              modelProvider: "",
              reasoning: "",
            },
          },
        });
        agentId = agent.id;
      }
      if (!agentId) throw new AppError("INVALID_INPUT");

      await enrollGeneralChannel(tx, input.workspaceId);
      return tx.weeklyReportCollectorBinding.create({
        data: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          computerId: input.computerId,
          collectorAgentId: agentId,
        },
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const existing = await db.weeklyReportCollectorBinding.findUnique({
      where: {
        workspaceId_userId_computerId: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          computerId: input.computerId,
        },
      },
    });
    if (existing) return existing;
    throw error;
  }
}

/** Lists Computers the User owns in the Workspace and each Collector readiness row. */
export async function listOwnedComputerSlots(
  db: PrismaClient,
  input: { workspaceId: string; userId: string },
): Promise<CollectorComputerSlot[]> {
  const mounted = await db.workspaceComputer.findMany({
    where: { workspaceId: input.workspaceId },
    select: {
      computerId: true,
      computer: { select: { id: true, ownerId: true, displayName: true, name: true } },
    },
    orderBy: { computerId: "asc" },
  });
  const owned = mounted.filter((row) => row.computer.ownerId === input.userId);
  const bindings = await db.weeklyReportCollectorBinding.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      computerId: { in: owned.map((row) => row.computerId) },
    },
    select: { id: true, computerId: true, collectorAgentId: true },
  });
  const bindingByComputer = new Map(bindings.map((row) => [row.computerId, row]));
  const agents = await db.agent.findMany({
    where: {
      workspaceId: input.workspaceId,
      id: { in: bindings.map((row) => row.collectorAgentId) },
    },
    select: { id: true, computerId: true, runtimeConfig: true },
  });
  const agentById = new Map(agents.map((row) => [row.id, row]));

  return owned.map((row) => {
    const binding = bindingByComputer.get(row.computerId);
    const agent = binding ? agentById.get(binding.collectorAgentId) : undefined;
    const computerConfigured = Boolean(agent?.computerId === row.computerId);
    const runtimeOk = agent ? collectorRuntimeConfigured(agent.runtimeConfig) : false;
    return {
      computerId: row.computerId,
      displayName: row.computer.displayName || row.computer.name || row.computerId,
      hostname: row.computer.name,
      bindingId: binding?.id ?? null,
      collectorAgentId: binding?.collectorAgentId ?? null,
      computerConfigured,
      runtimeConfigured: runtimeOk,
      ready: Boolean(binding && computerConfigured && runtimeOk),
    };
  });
}
