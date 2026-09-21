import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

const SUBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!SUBJECT_ID.test(input.subjectId)) throw new AppError("INVALID_INPUT");

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
