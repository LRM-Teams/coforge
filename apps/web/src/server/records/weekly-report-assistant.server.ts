import type { PrismaClient } from "../../../generated/client";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { enrollGeneralChannel } from "../conversations/public-channels.server";

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
      await enrollGeneralChannel(tx, input.workspaceId);
      return tx.weeklyReportAssistant.create({
        data: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          agentId: agent.id,
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
