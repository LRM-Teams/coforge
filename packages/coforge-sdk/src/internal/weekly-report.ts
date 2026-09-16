/** Agent HTTPS weekly-report reads. Authorization is the assistant owner User. */
export const AGENT_WEEKLY_REPORT_METHOD = "agent:weekly-report" as const;
export const WEEKLY_REPORT_PROTOCOL_MAJOR = 1 as const;

export const WEEKLY_REPORT_SUBJECT_TYPES = ["report", "highlight", "cycle"] as const;
export type WeeklyReportSubjectType = (typeof WEEKLY_REPORT_SUBJECT_TYPES)[number];

export type WeeklyReportCommand =
  | {
      operation: "context";
      subjectType: WeeklyReportSubjectType;
      subjectId: string;
    }
  | {
      operation: "list";
      cycleId?: string;
      cursor?: string;
      limit?: number;
    }
  | {
      operation: "read";
      reportId: string;
      section: string;
      maxCharacters?: number;
    };

export type WeeklyReportRequest = WeeklyReportCommand & {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
};

export type WeeklyReportResponse = {
  protocolMajor: number;
  requestId: string;
  operation: WeeklyReportCommand["operation"];
  result: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT_TYPES = new Set<string>(WEEKLY_REPORT_SUBJECT_TYPES);

function isNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function validateWeeklyReportRequest(value: unknown): WeeklyReportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid weekly-report request");
  const row = value as Record<string, unknown>;
  if (
    row.protocolMajor !== WEEKLY_REPORT_PROTOCOL_MAJOR ||
    !isNonblank(row.requestId) ||
    !isNonblank(row.workspaceId) ||
    !isNonblank(row.agentId)
  )
    throw new Error("invalid weekly-report request");
  const operation = row.operation;
  if (operation === "context") {
    if (!SUBJECT_TYPES.has(String(row.subjectType)) || !isUuid(row.subjectId))
      throw new Error("invalid weekly-report request");
    return {
      protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
      requestId: row.requestId,
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      operation: "context",
      subjectType: row.subjectType as WeeklyReportSubjectType,
      subjectId: row.subjectId,
    };
  }
  if (operation === "list") {
    if (row.cycleId !== undefined && !isUuid(row.cycleId))
      throw new Error("invalid weekly-report request");
    if (row.cursor !== undefined && !isUuid(row.cursor))
      throw new Error("invalid weekly-report request");
    if (
      row.limit !== undefined &&
      (!Number.isInteger(row.limit) || Number(row.limit) < 1 || Number(row.limit) > 50)
    )
      throw new Error("invalid weekly-report request");
    return {
      protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
      requestId: row.requestId,
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      operation: "list",
      ...(row.cycleId ? { cycleId: row.cycleId as string } : {}),
      ...(row.cursor ? { cursor: row.cursor as string } : {}),
      ...(row.limit !== undefined ? { limit: row.limit as number } : {}),
    };
  }
  if (operation === "read") {
    if (!isUuid(row.reportId) || !isNonblank(row.section) || String(row.section).length > 100)
      throw new Error("invalid weekly-report request");
    if (
      row.maxCharacters !== undefined &&
      (!Number.isInteger(row.maxCharacters) ||
        Number(row.maxCharacters) < 1 ||
        Number(row.maxCharacters) > 12_000)
    )
      throw new Error("invalid weekly-report request");
    return {
      protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
      requestId: row.requestId,
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      operation: "read",
      reportId: row.reportId,
      section: String(row.section).trim(),
      ...(row.maxCharacters !== undefined ? { maxCharacters: row.maxCharacters as number } : {}),
    };
  }
  throw new Error("invalid weekly-report request");
}

export function encodeWeeklyReportRequest(request: WeeklyReportRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(validateWeeklyReportRequest(request)));
}

export function decodeWeeklyReportRequest(bytes: Uint8Array): WeeklyReportRequest {
  try {
    return validateWeeklyReportRequest(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new Error("invalid weekly-report request");
  }
}

export function encodeWeeklyReportResponse(response: WeeklyReportResponse): Uint8Array {
  if (
    response.protocolMajor !== WEEKLY_REPORT_PROTOCOL_MAJOR ||
    !isNonblank(response.requestId) ||
    !["context", "list", "read"].includes(response.operation)
  )
    throw new Error("invalid weekly-report response");
  return new TextEncoder().encode(
    JSON.stringify({
      protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
      requestId: response.requestId,
      operation: response.operation,
      result: response.result ?? null,
    }),
  );
}

export function decodeWeeklyReportResponse(bytes: Uint8Array): WeeklyReportResponse {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid weekly-report response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid weekly-report response");
  const row = value as Record<string, unknown>;
  if (
    row.protocolMajor !== WEEKLY_REPORT_PROTOCOL_MAJOR ||
    !isNonblank(row.requestId) ||
    !["context", "list", "read"].includes(String(row.operation))
  )
    throw new Error("invalid weekly-report response");
  return {
    protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
    requestId: row.requestId,
    operation: row.operation as WeeklyReportCommand["operation"],
    result: row.result ?? null,
  };
}
