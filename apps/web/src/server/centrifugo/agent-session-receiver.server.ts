import { decodeAgentSessionReport } from "@coforge/protocol";
import type { AgentSessionReceiver } from "../agents/agent-session.server";
import type { AgentSessions } from "../agents/agent-sessions.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

export function createAgentSessionMethod(
  sessions: Pick<AgentSessions, "accept" | "verify">,
  receiver?: AgentSessionReceiver,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    if (
      !metadata.principal.userId ||
      !metadata.principal.workspaceId ||
      !metadata.principal.computerId
    )
      return { code: 401, message: "daemon authentication required" };
    if (metadata.principal.agentId) return { code: 403, message: "daemon authentication required" };
    try {
      const report = decodeAgentSessionReport(payload);
      if (
        metadata.principal.workspaceId !== report.workspaceId ||
        metadata.principal.computerId !== report.computerId
      )
        return { code: 403, message: "Agent session scope is not authorized" };
      await receiver?.authorize(metadata.principal, report);
      if (
        report.sequence !== undefined &&
        report.controlEpoch !== undefined &&
        report.sessionState
      ) {
        if (!receiver) throw new Error("Session snapshots are unsupported");
        await sessions.verify(report);
        await receiver.accept(metadata.principal, {
          ...report,
          requestId: report.startRequestId,
          epoch: report.controlEpoch,
          sequence: report.sequence,
          identity: { sessionId: report.sessionId, state: report.sessionState },
        });
      } else {
        await sessions.accept(report);
      }
      return new Uint8Array();
    } catch {
      return { code: 403, message: "Agent Session snapshot is not authorized" };
    }
  };
}
