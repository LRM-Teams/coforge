/**
 * What a rejected Agent RPC result logs as.
 *
 * Both receivers — `agent-control-receiver.server.ts` and `agent-session-receiver.server.ts` — reject
 * the same way: a refusal is normal traffic, not an incident, so a message their collaborators throw
 * on purpose is logged as itself, and anything else becomes `unexpected: <error name>`. That keeps a
 * rejection visible without ever logging an arbitrary error message or payload.
 *
 * Each receiver passes its own allowlist, because each names a different set of collaborators and so a
 * different set of fixed messages.
 */
export function rejectionReason(error: unknown, known: ReadonlySet<string>): string {
  const message = error instanceof Error ? error.message : undefined;
  if (message && known.has(message)) return message;
  return `unexpected: ${error instanceof Error ? error.name : typeof error}`;
}
