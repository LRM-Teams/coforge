import { WEEKLY_REPORT_PROTOCOL_MAJOR, type WeeklyReportCommand } from "@lrm/coforge-sdk/internal";
import { isAppError } from "../../lib/app-error";

/** The agent HTTP API's own shape: the shared weekly-report command and response call this key
 * `requestId` (it also crosses the local RPC and its protobuf), while the wire names it
 * `idempotencyKey`. The two names meet in this HTTP layer and nowhere else. */
export type WeeklyReportWireRequest = WeeklyReportCommand & {
  protocolMajor: number;
  workspaceId: string;
  agentId: string;
  idempotencyKey?: string;
};
export type WeeklyReportWireResponse = {
  protocolMajor: number;
  idempotencyKey?: string;
  operation: WeeklyReportCommand["operation"];
  result: unknown;
};

type WeeklyReportCatalog = {
  loadAssistantContextManifest(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
  }): Promise<unknown>;
  listAssistantVisibleReports(input: {
    workspaceId: string;
    userId: string;
    cycleId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<unknown>;
  readAssistantReportSection(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    section: string;
    maxCharacters?: number;
  }): Promise<unknown>;
};

type WeeklyReportAuthorization = {
  computerIdForAuthorizedAgent(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<string | undefined>;
  weeklyReportAssistantOwner(
    workspaceId: string,
    agentId: string,
  ): Promise<{ userId: string } | undefined>;
};

type WeeklyReportPrincipal = {
  userId: string;
  workspaceId: string;
  computerId: string;
  agentId?: string;
};

/** Authorized weekly-report reads for the assistant owner User over Agent HTTPS REST. */
export async function executeAgentWeeklyReport(
  catalog: WeeklyReportCatalog,
  authorization: WeeklyReportAuthorization,
  request: WeeklyReportWireRequest,
  principal: WeeklyReportPrincipal,
): Promise<{ response: WeeklyReportWireResponse } | { error: { code: number; message: string } }> {
  const assignedComputerId = principal.agentId
    ? await authorization.computerIdForAuthorizedAgent(
        principal.workspaceId,
        principal.agentId,
        principal.userId,
      )
    : undefined;
  if (
    request.protocolMajor !== WEEKLY_REPORT_PROTOCOL_MAJOR ||
    !principal.agentId ||
    request.agentId !== principal.agentId ||
    request.workspaceId !== principal.workspaceId ||
    assignedComputerId !== principal.computerId
  )
    return { error: { code: 403, message: "Weekly report principal scope mismatch" } };
  const owner = await authorization.weeklyReportAssistantOwner(
    principal.workspaceId,
    principal.agentId,
  );
  if (!owner || owner.userId !== principal.userId)
    return { error: { code: 403, message: "Weekly report assistant access denied" } };
  try {
    const {
      protocolMajor: _protocolMajor,
      workspaceId,
      agentId: _agentId,
      idempotencyKey,
      ...command
    } = request;
    const result = await executeWeeklyReportRead(catalog, workspaceId, owner.userId, command);
    return {
      response: {
        protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
        idempotencyKey,
        operation: command.operation,
        result,
      },
    };
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === "NOT_FOUND")
        return { error: { code: 400, message: "Weekly report not found" } };
      if (error.code === "ACCESS_DENIED")
        return { error: { code: 403, message: "Weekly report access denied" } };
    }
    return { error: { code: 400, message: "invalid weekly-report request" } };
  }
}

async function executeWeeklyReportRead(
  catalog: WeeklyReportCatalog,
  workspaceId: string,
  userId: string,
  command: WeeklyReportCommand,
) {
  if (command.operation === "context") {
    return catalog.loadAssistantContextManifest({
      workspaceId,
      userId,
      subjectType: command.subjectType,
      subjectId: command.subjectId,
    });
  }
  if (command.operation === "list") {
    return catalog.listAssistantVisibleReports({
      workspaceId,
      userId,
      cycleId: command.cycleId,
      cursor: command.cursor,
      limit: command.limit,
    });
  }
  return catalog.readAssistantReportSection({
    workspaceId,
    userId,
    reportId: command.reportId,
    section: command.section,
    maxCharacters: command.maxCharacters,
  });
}
