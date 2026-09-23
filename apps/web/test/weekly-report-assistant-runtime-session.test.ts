import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ensureWeeklyReportAssistantRuntimeSession } from "#src/server/records/weekly-report-assistant-runtime-session.server";
import { planWeeklyReportAssistantSubjectLaunch } from "#src/server/records/weekly-report-assistant-subject-launch.server";

function memoryDb() {
  const rows = new Map<
    string,
    { sessionId: string; subjectType: string; subjectId: string; agentId: string }
  >();
  const db = {
    $transaction: async (fn: (tx: PrismaClient) => Promise<unknown>) =>
      fn(db as unknown as PrismaClient),
    weeklyReportAssistantRuntimeSession: {
      findUnique: async ({
        where,
      }: {
        where: {
          workspaceId_agentId_subjectType_subjectId: {
            workspaceId: string;
            agentId: string;
            subjectType: string;
            subjectId: string;
          };
        };
      }) => {
        const key = JSON.stringify(where.workspaceId_agentId_subjectType_subjectId);
        return rows.get(key) ?? null;
      },
      create: async ({
        data,
      }: {
        data: {
          workspaceId: string;
          agentId: string;
          subjectType: string;
          subjectId: string;
          sessionId: string;
        };
      }) => {
        const key = JSON.stringify({
          workspaceId: data.workspaceId,
          agentId: data.agentId,
          subjectType: data.subjectType,
          subjectId: data.subjectId,
        });
        const row = {
          sessionId: data.sessionId,
          subjectType: data.subjectType,
          subjectId: data.subjectId,
          agentId: data.agentId,
        };
        rows.set(key, row);
        return row;
      },
    },
  };
  return db as unknown as PrismaClient;
}

test("ensureWeeklyReportAssistantRuntimeSession reuses one session per report subject", async () => {
  const db = memoryDb();
  const first = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "report",
    subjectId: "11111111-1111-4111-8111-111111111111",
  });
  const again = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "report",
    subjectId: "11111111-1111-4111-8111-111111111111",
  });
  const other = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "report",
    subjectId: "22222222-2222-4222-8222-222222222222",
  });

  expect(first.created).toBe(true);
  expect(again).toEqual({ sessionId: first.sessionId, created: false });
  expect(other.sessionId).not.toBe(first.sessionId);
  expect(other.created).toBe(true);
});

test("ensureWeeklyReportAssistantRuntimeSession isolates cycle subjects from reports", async () => {
  const db = memoryDb();
  const subjectId = "33333333-3333-4333-8333-333333333333";
  const report = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "report",
    subjectId,
  });
  const cycle = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "cycle",
    subjectId,
  });
  expect(cycle.sessionId).not.toBe(report.sessionId);
});

test("side chat on one report does not replace another report's runtime session", async () => {
  const db = memoryDb();
  const reportA = "11111111-1111-4111-8111-111111111111";
  const reportB = "22222222-2222-4222-8222-222222222222";
  const subjectA = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "report",
    subjectId: reportA,
  });
  const subjectB = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "report",
    subjectId: reportB,
  });
  const subjectAAgain = await ensureWeeklyReportAssistantRuntimeSession(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    subjectType: "report",
    subjectId: reportA,
  });
  expect(subjectAAgain.sessionId).toBe(subjectA.sessionId);
  expect(
    planWeeklyReportAssistantSubjectLaunch({
      mappedSessionId: subjectA.sessionId,
      mappingCreated: false,
      phase: "completed",
      action: "start",
      runningSessionId: subjectB.sessionId,
      stoppedByUser: false,
    }),
  ).toEqual({
    action: "stop-then-start",
    sessionId: subjectA.sessionId,
    sessionMode: "resume",
  });
});
