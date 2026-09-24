import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";

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

/** Map standard domain refusals once for Agent HTTP adapters that expose JSON errors. */
export function agentRouteDomainErrorResponse(error: unknown, fallbackMessage: string): Response {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code === "NOT_FOUND") return Response.json({ error: "not found" }, { status: 404 });
  if (code === "ACCESS_DENIED") return Response.json({ error: "forbidden" }, { status: 403 });
  if (code === "INVALID_INPUT") return Response.json({ error: "invalid input" }, { status: 400 });
  return Response.json({ error: fallbackMessage }, { status: 400 });
}
