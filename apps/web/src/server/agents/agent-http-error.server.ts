import type { AgentApiRefusal } from "@lrm/coforge-sdk/agent";

/**
 * The Agent HTTP API's error envelope: `{ error, code, retryable }` with the status — the SDK's
 * `AgentApiRefusal`, which the daemon relays to the Agent with its code only in exactly this shape.
 *
 * The Agent CLI reads `retryable` to decide whether to try an upload again, so every route that
 * answers with this shape has to agree on it. The three attachment-upload-session routes each kept
 * their own identical copy of this responder — thirteen call sites between them — which is why it
 * lives here now.
 */
export function errorResponse(code: string, message: string, status: number, retryable: boolean) {
  return Response.json({ error: message, code, retryable } satisfies AgentApiRefusal, { status });
}
