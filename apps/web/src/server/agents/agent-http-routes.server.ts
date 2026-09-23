import { AgentMessageValidationError } from "@/server/conversations/agent-message-validation-error.server";

/** The optional request envelope shared by Agent POST endpoints. */
export type AgentJsonBody = Record<string, unknown>;

/** Read an optional JSON envelope without making empty bodies a route-specific concern. */
export async function readAgentJsonBody(request: Request): Promise<AgentJsonBody | undefined> {
  return (await request.json().catch(() => undefined)) as AgentJsonBody | undefined;
}

/** Preserve a caller's idempotency key and generate one for clients that omit it. */
export function agentIdempotencyKey(body: AgentJsonBody | undefined): string {
  const value = body?.idempotencyKey;
  return typeof value === "string" && value ? value : crypto.randomUUID();
}

/** Read the same key from a GET query string used by read-only Agent endpoints. */
export function agentIdempotencyKeyFromQuery(request: Request): string {
  return new URL(request.url).searchParams.get("idempotencyKey") || crypto.randomUUID();
}

/** Keep Agent validation failures visible while hiding unexpected repository details. */
export function agentRouteErrorResponse(
  error: unknown,
  fallbackMessage: string,
  knownValidationMessages: readonly string[] = [],
): Response {
  if (error instanceof AgentMessageValidationError)
    return new Response(error.message, { status: 400 });
  if (error instanceof Error && knownValidationMessages.includes(error.message))
    return new Response(error.message, { status: 400 });
  return new Response(fallbackMessage, { status: 400 });
}
