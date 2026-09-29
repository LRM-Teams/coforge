import { AgentChannelManagementError } from "#src/server/conversations/agent-channel-management-error.server";

/** Who a channel-management route acts as: one Agent, in one Workspace. Declared once here because
 * the whole family shares it - the route files under `routes/api/agent/v1/channels*` each used to
 * spell it out, and export it, themselves (nothing imported those copies). */
export type AgentChannelManagementPrincipal = { workspaceId: string; agentId: string };

export {
  agentIdempotencyKey as idempotencyKeyFrom,
  agentIdempotencyKeyFromQuery as idempotencyKeyFromQuery,
  readAgentJsonBody as readJsonBody,
} from "./agent-http-routes.server";

/** Reads a POST body as JSON, tolerating an empty/absent body (every route here treats `idempotencyKey`
 * as optional, matching the mute/unmute routes this family was modeled on). */
/**
 * Maps a channel-management failure onto its declared HTTP status and body; anything else (an
 * unexpected repository failure) is hidden behind a generic message, matching the mute/unmute
 * routes' `catch` behavior. An `errorCode`-carrying failure (`agent_not_visible`)
 * serializes as the `{ ok: false, errorCode, error }` JSON envelope so the Agent CLI can read a
 * real wire field instead of the message text; every other failure stays plain text.
 */
export function channelManagementErrorResponse(error: unknown, fallbackMessage: string): Response {
  if (error instanceof AgentChannelManagementError) {
    if (error.errorCode)
      return Response.json(
        { ok: false, errorCode: error.errorCode, error: error.message },
        { status: error.status },
      );
    return new Response(error.message, { status: error.status });
  }
  return new Response(fallbackMessage, { status: 400 });
}
