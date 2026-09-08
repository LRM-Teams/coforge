import { decodeAgentControlResult } from "@coforge/protocol";
import type { AgentControl } from "../agents/agent-control.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

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
    try {
      await control.result(metadata.principal, decodeAgentControlResult(payload));
      return new Uint8Array();
    } catch {
      return { code: 403, message: "Agent control result is not authorized" };
    }
  };
}
