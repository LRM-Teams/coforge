import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

export type WeeklyReportSubjectType = "report" | "cycle";

/**
 * Cloud reservation for the WeeklyReportAssistant Agent session bound to one
 * Records page subject (ADR 0060). Distinct from the side-chat thread and from
 * `Agent.currentSessionId`.
 */
export async function ensureWeeklyReportAssistantRuntimeSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    subjectType: WeeklyReportSubjectType;
    subjectId: string;
  },
): Promise<{ sessionId: string; created: boolean }> {
  if (input.subjectType !== "report" && input.subjectType !== "cycle") {
    throw new AppError("INVALID_INPUT");
  }
  if (!RFC_UUID_PATTERN.test(input.subjectId)) throw new AppError("INVALID_INPUT");

  return db.$transaction(async (tx) => {
    const existing = await tx.weeklyReportAssistantRuntimeSession.findUnique({
      where: {
        workspaceId_agentId_subjectType_subjectId: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
        },
      },
      select: { sessionId: true },
    });
    if (existing) return { sessionId: existing.sessionId, created: false };

    const sessionId = crypto.randomUUID();
    await tx.weeklyReportAssistantRuntimeSession.create({
      data: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        sessionId,
      },
    });
    return { sessionId, created: true };
  });
}
