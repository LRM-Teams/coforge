import { expect, test } from "bun:test";

test("ensureWeeklyReportAssistantChatSession creates a first session and backfills legacy comments", async () => {
  const { ensureWeeklyReportAssistantChatSession } =
    await import("@/server/records/weekly-report-assistant-chat-session.server");

  let created: {
    id: string;
    title: string;
    subjectType: string;
    subjectId: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  } | null = null;
  let updatedSessionId: string | null = null;
  const db = {
    workspaceMembership: {
      findUniqueOrThrow: async () => ({ workspaceId: "ws", userId: "user-1" }),
    },
    weeklyReportAssistantChatSession: {
      findMany: async () => (created ? [created] : []),
      create: async ({ data }: { data: { title: string } }) => {
        created = {
          id: "session-1",
          title: data.title,
          subjectType: "report",
          subjectId: "report-1",
          status: "active",
          createdAt: new Date("2026-09-18T00:00:00.000Z"),
          updatedAt: new Date("2026-09-18T00:00:00.000Z"),
        };
        return created;
      },
    },
    recordComment: {
      count: async () => 2,
      updateMany: async ({ data }: { data: { assistantSessionId: string } }) => {
        updatedSessionId = data.assistantSessionId;
        return { count: 2 };
      },
    },
  };

  const result = await ensureWeeklyReportAssistantChatSession(db as never, {
    workspaceId: "ws",
    userId: "user-1",
    subjectType: "report",
    subjectId: "report-1",
  });

  expect(result.activeSessionId).toBe("session-1");
  expect(result.legacySessionId).toBe("session-1");
  expect(result.sessions).toHaveLength(1);
  expect(updatedSessionId as string | null).toBe("session-1");
});

test("createWeeklyReportAssistantChatSession opens an empty side-chat thread", async () => {
  const { createWeeklyReportAssistantChatSession } =
    await import("@/server/records/weekly-report-assistant-chat-session.server");
  const db = {
    workspaceMembership: {
      findUniqueOrThrow: async () => ({ workspaceId: "ws", userId: "user-1" }),
    },
    weeklyReportAssistantChatSession: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "session-new",
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        title: data.title,
        status: data.status,
        createdAt: new Date("2026-09-18T01:00:00.000Z"),
        updatedAt: new Date("2026-09-18T01:00:00.000Z"),
      }),
    },
  };

  const created = await createWeeklyReportAssistantChatSession(db as never, {
    workspaceId: "ws",
    userId: "user-1",
    subjectType: "report",
    subjectId: "report-1",
  });

  expect(created).toMatchObject({
    id: "session-new",
    title: "",
    status: "active",
    subjectType: "report",
    subjectId: "report-1",
  });
});
