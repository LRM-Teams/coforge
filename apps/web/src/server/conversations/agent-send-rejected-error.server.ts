/**
 * A `message send`-specific rejection the send route should report verbatim, with its own HTTP
 * status: unlike `AppError` (whose codes are shared across many call sites, including
 * `getAgentChannel`'s `ACCESS_DENIED`/`INVALID_INPUT` for an ordinary channel-access or
 * malformed-target failure), this class is only ever thrown for the two conditions the repository
 * raises inside `sendAgentMessage`'s own transaction: an unavailable attachment, or a mention
 * binding that does not match a conversation member. The route maps only this class; every other
 * thrown error (including `AppError`) is left to propagate exactly as it did before this type
 * existed.
 */
export class AgentSendRejectedError extends Error {
  readonly status: 400 | 403;

  constructor(status: 400 | 403, message: string) {
    super(message);
    this.name = "AgentSendRejectedError";
    this.status = status;
  }
}
