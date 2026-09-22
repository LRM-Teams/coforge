import type { PrismaClient } from "../../../generated/client";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AppError } from "../../lib/app-error";

export const WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME = "周报助手";

export function weeklyReportAssistantAgentName(userId: string): string {
  return `weekly-report-assistant-${userId}`;
}

export type WeeklyReportAssistantRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Returns the User's stable weekly-report Agent, creating its unconfigured
 * Agent identity atomically on first use.
 *
 * Reclaims an orphan Agent left by a previous partial create (Agent row exists,
 * WeeklyReportAssistant link missing) so Members loader does not die on
 * `agents_workspaceId_name_key`.
 */
export async function ensureWeeklyReportAssistant(
  db: PrismaClient,
  input: { workspaceId: string; userId: string },
): Promise<WeeklyReportAssistantRecord> {
  const agentName = weeklyReportAssistantAgentName(input.userId);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.weeklyReportAssistant.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
      });
      if (existing) return existing;

      const orphan = await tx.agent.findUnique({
        where: {
          workspaceId_name: { workspaceId: input.workspaceId, name: agentName },
        },
        select: { id: true, ownerId: true, deletedAt: true },
      });

      let agentId: string;
      if (orphan) {
        if (orphan.ownerId !== input.userId) throw new AppError("ACCESS_DENIED");
        if (orphan.deletedAt) {
          await tx.agent.update({
            where: { id_workspaceId: { id: orphan.id, workspaceId: input.workspaceId } },
            data: {
              deletedAt: null,
              displayName: WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
            },
          });
        }
        agentId = orphan.id;
      } else {
        const agent = await tx.agent.create({
          data: {
            workspaceId: input.workspaceId,
            ownerId: input.userId,
            name: agentName,
            displayName: WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
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

      return tx.weeklyReportAssistant.create({
        data: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          agentId,
        },
      });
    });
  } catch (error) {
    // A concurrent first request may lose the unique insert race; reuse its row.
    const existing = await db.weeklyReportAssistant.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
      },
    });
    if (existing) return existing;
    throw error;
  }
}

export async function weeklyReportAssistantOwner(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string },
): Promise<{ userId: string } | undefined> {
  const row = await db.weeklyReportAssistant.findFirst({
    where: { workspaceId: input.workspaceId, agentId: input.agentId },
    select: { userId: true },
  });
  return row ?? undefined;
}
