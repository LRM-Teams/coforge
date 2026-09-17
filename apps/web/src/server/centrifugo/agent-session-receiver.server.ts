import {
  decodeAgentSessionInvalidate,
  decodeAgentSessionReport,
  type AgentSessionReport,
} from "@lrm/coforge-sdk/internal";
import type { AgentSessionReceiver } from "../agents/agent-session.server";
import type { AgentSessions } from "../agents/agent-sessions.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/** Every fixed message this handler's collaborators throw for a rejected snapshot: the shared
 * `requireCurrentAgentScope`, `AgentSessionReceiver`, and `AgentSessions`. Mirrors the same
 * allowlist discipline as `agent-control-receiver.server.ts`'s sibling handler. */
const KNOWN_REJECTION_REASONS = new Set([
  "Stale Agent scope",
  "Agent Session scope is not authorized",
  "Session launch is not current",
  "Native Session identity changed during launch",
  "Session snapshot lost its fence",
  "Agent session report is stale or unauthorized",
  "Agent session identity changed concurrently",
  "Session snapshots are unsupported",
]);

function rejectionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : undefined;
  if (message && KNOWN_REJECTION_REASONS.has(message)) return message;
  return `unexpected: ${error instanceof Error ? error.name : typeof error}`;
}

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
    let report: AgentSessionReport | undefined;
    try {
      report = decodeAgentSessionReport(payload);
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
    } catch (error) {
      // A rejected snapshot previously vanished as a bare 403, the same silent pattern fixed
      // for `agent:control:result`; log it for the same diagnosability.
      console.warn(
        JSON.stringify({
          event: "agent_session:snapshot_rejected",
          agent_id: report?.agentId,
          workspace_id: metadata.principal.workspaceId,
          computer_id: metadata.principal.computerId,
          epoch: report?.controlEpoch,
          sequence: report?.sequence,
          reason: rejectionReason(error),
        }),
      );
      return { code: 403, message: "Agent Session snapshot is not authorized" };
    }
  };
}

/**
 * Fire-and-forget from the daemon's side (the daemon never awaits or retries this RPC's
 * result). A malformed payload or foreign scope is a 403, matching `createAgentSessionMethod`;
 * a *recognized but no-longer-current* invalidate (stale launch, already-replaced Session,
 * stale daemon instance) is `AgentSessionReceiver.invalidate`'s own idempotent no-op, not an
 * error, since the daemon must never treat that as something to retry.
 */
export function createAgentSessionInvalidateMethod(
  receiver: Pick<AgentSessionReceiver, "invalidate">,
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
      const message = decodeAgentSessionInvalidate(payload);
      if (
        metadata.principal.workspaceId !== message.workspaceId ||
        metadata.principal.computerId !== message.computerId
      )
        return { code: 403, message: "Agent session scope is not authorized" };
      await receiver.invalidate(metadata.principal, message);
      return new Uint8Array();
    } catch {
      return { code: 403, message: "Agent Session invalidate is not authorized" };
    }
  };
}
