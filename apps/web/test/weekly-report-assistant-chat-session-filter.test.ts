import { expect, test } from "bun:test";
import { selectWeeklyReportAssistantMessages } from "@/server/records/weekly-report-assistant-chat.server";
import { buildWeeklyReportAssistantRequestBody } from "@/server/records/weekly-report-assistant-request.server";

test("page-scoped message selection also isolates side-chat sessions", () => {
  const sessionA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const sessionB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const bodyA = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "report-a",
    sessionId: sessionA,
    userText: "Turn in session A",
    contextManifest: null,
  });
  const bodyB = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "report-a",
    sessionId: sessionB,
    userText: "Turn in session B",
    contextManifest: null,
  });
  const selected = selectWeeklyReportAssistantMessages(
    [
      {
        id: "1",
        sequence: 1,
        body: bodyA,
        senderKind: "user",
        createdAt: "2026-09-18T00:00:00.000Z",
      },
      {
        id: "2",
        sequence: 2,
        body: "Reply A",
        senderKind: "agent",
        createdAt: "2026-09-18T00:00:01.000Z",
      },
      {
        id: "3",
        sequence: 3,
        body: bodyB,
        senderKind: "user",
        createdAt: "2026-09-18T00:00:02.000Z",
      },
      {
        id: "4",
        sequence: 4,
        body: "Reply B",
        senderKind: "agent",
        createdAt: "2026-09-18T00:00:03.000Z",
      },
    ],
    "report",
    "report-a",
    sessionA,
  );
  expect(selected.map((row) => row.id)).toEqual(["1", "2"]);
  expect(selected[0]?.displayBody).toBe("Turn in session A");
});

test("legacy unscoped turns appear only when includeLegacyUnscoped is set", () => {
  const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const legacyBody = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "report-a",
    userText: "Legacy turn",
    contextManifest: null,
  });
  const scopedBody = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "report-a",
    sessionId,
    userText: "Scoped turn",
    contextManifest: null,
  });
  const messages = [
    {
      id: "1",
      sequence: 1,
      body: legacyBody,
      senderKind: "user" as const,
      createdAt: "2026-09-18T00:00:00.000Z",
    },
    {
      id: "2",
      sequence: 2,
      body: "Legacy reply",
      senderKind: "agent" as const,
      createdAt: "2026-09-18T00:00:01.000Z",
    },
    {
      id: "3",
      sequence: 3,
      body: scopedBody,
      senderKind: "user" as const,
      createdAt: "2026-09-18T00:00:02.000Z",
    },
    {
      id: "4",
      sequence: 4,
      body: "Scoped reply",
      senderKind: "agent" as const,
      createdAt: "2026-09-18T00:00:03.000Z",
    },
  ];
  expect(
    selectWeeklyReportAssistantMessages(messages, "report", "report-a", sessionId).map(
      (row) => row.id,
    ),
  ).toEqual(["3", "4"]);
  expect(
    selectWeeklyReportAssistantMessages(messages, "report", "report-a", sessionId, {
      includeLegacyUnscoped: true,
    }).map((row) => row.id),
  ).toEqual(["1", "2", "3", "4"]);
});
