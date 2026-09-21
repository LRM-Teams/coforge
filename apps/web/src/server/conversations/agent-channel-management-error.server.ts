/**
 * A channel-management failure with an exact HTTP status and plain-text body, in the same
 * spirit as `AgentMessageValidationError` (which is always 400): channel lifecycle/roster
 * operations need 400/403/404/409 depending on the failure, so the status travels with the
 * error instead of being inferred by the route.
 *
 * `errorCode` is the one exception to "plain text": ADR 0059's `agent_not_visible` (the CLI's
 * stable "this Agent is private and you cannot see it" outcome, distinct from a genuinely
 * unknown handle) needs a real wire field the CLI can read, not a message string it would have
 * to pattern-match. `channelManagementErrorResponse` serializes it as the same `{ ok: false,
 * errorCode, error }` envelope `user info`/`profile show` already use; every other channel
 * error still has no `errorCode` and stays plain text.
 */
export class AgentChannelManagementError extends Error {
  readonly status: number;
  readonly errorCode?: string;

  constructor(status: number, message: string, errorCode?: string) {
    super(message);
    this.name = "AgentChannelManagementError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

export function channelAuthorityDeniedError(operation: string): AgentChannelManagementError {
  return new AgentChannelManagementError(
    403,
    `this Agent's owner lacks admin authority for ${operation}`,
  );
}
