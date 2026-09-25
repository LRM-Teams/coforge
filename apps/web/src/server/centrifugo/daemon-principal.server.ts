import type { AuthenticatedDaemonPrincipal, CentrifugoRpcError } from "./rpc-handler.server";

/**
 * The gate the daemon→cloud receivers share: the principal must be a Computer's daemon — carrying
 * a `userId`, `workspaceId` and `computerId` — and must not be an Agent. Returns the rejection to
 * hand back, or `undefined` to continue.
 *
 * `agent-control-receiver.server.ts` keeps its own variant (an Agent principal is a 401 there, and
 * it does not require a `userId`), so it does not import this.
 */
export function rejectNonDaemonPrincipal(
  principal: AuthenticatedDaemonPrincipal,
): CentrifugoRpcError | undefined {
  if (!principal.userId || !principal.workspaceId || !principal.computerId)
    return { code: 401, message: "daemon authentication required" };
  if (principal.agentId) return { code: 403, message: "daemon authentication required" };
  return undefined;
}
