import { decodeAgentControlResult, type AgentControlResult } from "@lrm/coforge-sdk/internal";
import type { AgentControl } from "#src/server/agents/agent-control.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/** Every fixed message `AgentControl.result` (and the `requireCurrentAgentScope` it shares with
 * Session acceptance) throws for a rejected result. Anything else logs as "unexpected" so a
 * rejection is never silent, without ever logging an arbitrary error message or payload. */
const KNOWN_REJECTION_REASONS = new Set([
  "Stale Agent scope",
  "Unexpected command result",
  "Unexpected launch result",
  "Operation already finished",
  "Reset retained old Session",
  "Native Session identity changed during launch",
  "Control result lost its fence",
]);

function rejectionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : undefined;
  if (message && KNOWN_REJECTION_REASONS.has(message)) return message;
  return `unexpected: ${error instanceof Error ? error.name : typeof error}`;
}

export function createAgentControlResultMethod(
  control: Pick<AgentControl, "result">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    if (
      metadata.principal.agentId ||
      !metadata.principal.workspaceId ||
      !metadata.principal.computerId
    )
      return { code: 401, message: "daemon authentication required" };
    let result: AgentControlResult;
    try {
      result = decodeAgentControlResult(payload);
    } catch {
      return { code: 403, message: "Agent control result is not authorized" };
    }
    try {
      await control.result(metadata.principal, result);
      return new Uint8Array();
    } catch (error) {
      // A rejected result previously vanished as a bare 403; log it so a stuck control
      // operation (nothing else drives it once the Daemon's ACK is refused) is diagnosable.
      console.warn(
        JSON.stringify({
          event: "agent_control:result_rejected",
          agent_id: result.agentId,
          workspace_id: metadata.principal.workspaceId,
          computer_id: metadata.principal.computerId,
          phase: result.phase,
          epoch: result.epoch,
          sequence: result.sequence,
          error_code: result.errorCode,
          reason: rejectionReason(error),
        }),
      );
      return { code: 403, message: "Agent control result is not authorized" };
    }
  };
}
