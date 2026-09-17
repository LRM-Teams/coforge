/**
 * A channel-management failure with an exact HTTP status and plain-text body, in the same
 * spirit as `AgentMessageValidationError` (which is always 400): channel lifecycle/roster
 * operations need 400/403/404/409 depending on the failure, so the status travels with the
 * error instead of being inferred by the route.
 */
export class AgentChannelManagementError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentChannelManagementError";
    this.status = status;
  }
}

export function channelAuthorityDeniedError(operation: string): AgentChannelManagementError {
  return new AgentChannelManagementError(
    403,
    `this Agent's owner lacks admin authority for ${operation}`,
  );
}
