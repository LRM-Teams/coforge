import { AgentChannelManagementError } from "../conversations/agent-channel-management-error.server";

/** Reads a POST body as JSON, tolerating an empty/absent body (every route here treats `requestId`
 * as optional, matching the mute/unmute routes this family was modeled on). */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  return (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
}

/** A caller-supplied `requestId` is echoed back; otherwise one is generated. */
export function requestIdFrom(body: Record<string, unknown> | undefined): string {
  const value = body?.requestId;
  return typeof value === "string" && value ? value : crypto.randomUUID();
}

/** Same idea, for a GET route's `requestId` query parameter. */
export function requestIdFromQuery(request: Request): string {
  return new URL(request.url).searchParams.get("requestId") || crypto.randomUUID();
}

/**
 * Maps a channel-management failure onto its declared HTTP status and plain-text body; anything
 * else (an unexpected repository failure) is hidden behind a generic message, matching the
 * mute/unmute routes' `catch` behavior.
 */
export function channelManagementErrorResponse(error: unknown, fallbackMessage: string): Response {
  if (error instanceof AgentChannelManagementError)
    return new Response(error.message, { status: error.status });
  return new Response(fallbackMessage, { status: 400 });
}
