import { AgentChannelManagementError } from "../conversations/agent-channel-management-error.server";

export {
  agentIdempotencyKey as idempotencyKeyFrom,
  agentIdempotencyKeyFromQuery as idempotencyKeyFromQuery,
  readAgentJsonBody as readJsonBody,
} from "./agent-http-routes.shared";

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
