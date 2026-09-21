import { AgentChannelManagementError } from "../conversations/agent-channel-management-error.server";

/** Reads a POST body as JSON, tolerating an empty/absent body (every route here treats `idempotencyKey`
 * as optional, matching the mute/unmute routes this family was modeled on). */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  return (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
}

/** A caller-supplied `idempotencyKey` is echoed back; otherwise one is generated. */
export function idempotencyKeyFrom(body: Record<string, unknown> | undefined): string {
  const value = body?.idempotencyKey;
  return typeof value === "string" && value ? value : crypto.randomUUID();
}

/** Same idea, for a GET route's `idempotencyKey` query parameter. */
export function idempotencyKeyFromQuery(request: Request): string {
  return new URL(request.url).searchParams.get("idempotencyKey") || crypto.randomUUID();
}

/**
 * Maps a channel-management failure onto its declared HTTP status and body; anything else (an
 * unexpected repository failure) is hidden behind a generic message, matching the mute/unmute
 * routes' `catch` behavior. An `errorCode`-carrying failure (ADR 0059's `agent_not_visible`)
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
