import { expect, test } from "bun:test";
import {
  decodeWeeklyReportRequest,
  decodeWeeklyReportResponse,
  encodeWeeklyReportRequest,
  encodeWeeklyReportResponse,
  WEEKLY_REPORT_PROTOCOL_MAJOR,
} from "./weekly-report";

const identity = {
  protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
};

test("weekly-report requests round-trip bounded context list and section reads", () => {
  const context = encodeWeeklyReportRequest({
    ...identity,
    operation: "context",
    subjectType: "report",
    subjectId: "11111111-1111-4111-8111-111111111111",
  });
  expect(decodeWeeklyReportRequest(context)).toMatchObject({ operation: "context" });

  const listed = decodeWeeklyReportRequest(
    encodeWeeklyReportRequest({
      ...identity,
      operation: "list",
      cycleId: "22222222-2222-4222-8222-222222222222",
      limit: 2,
    }),
  );
  expect(listed).toMatchObject({ operation: "list", limit: 2 });

  const read = encodeWeeklyReportRequest({
    ...identity,
    operation: "read",
    reportId: "33333333-3333-4333-8333-333333333333",
    section: "Progress",
    maxCharacters: 120,
  });
  expect(decodeWeeklyReportRequest(read)).toMatchObject({
    operation: "read",
    section: "Progress",
    maxCharacters: 120,
  });
});

test("weekly-report codec rejects oversize lists and missing section reads", () => {
  expect(() =>
    encodeWeeklyReportRequest({
      ...identity,
      operation: "list",
      limit: 51,
    }),
  ).toThrow("invalid weekly-report request");
  expect(() =>
    encodeWeeklyReportRequest({
      ...identity,
      operation: "read",
      reportId: "not-a-uuid",
      section: "Progress",
    }),
  ).toThrow("invalid weekly-report request");
});

test("weekly-report responses keep request correlation", () => {
  const bytes = encodeWeeklyReportResponse({
    protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
    requestId: "request-1",
    operation: "list",
    result: { reports: [], nextCursor: null },
  });
  expect(decodeWeeklyReportResponse(bytes)).toEqual({
    protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
    requestId: "request-1",
    operation: "list",
    result: { reports: [], nextCursor: null },
  });
});
