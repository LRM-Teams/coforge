/**
 * A `message send`-specific rejection the send route should report verbatim, with its own HTTP
 * status: unlike `AppError` (whose codes are shared across many call sites, including
 * `getAgentChannel`'s `ACCESS_DENIED`/`INVALID_INPUT` for an ordinary channel-access or
 * malformed-target failure), this class is only ever thrown for the conditions `sendAgentMessage`
 * itself raises: an unavailable attachment or a mention binding that does not match a conversation
 * member (both inside its own transaction), a private Agent's own outbound direct message (read-only
 * for everyone but its creator), and a missing or channel-soft-left Agent membership. A direct
 * message whose person is not a Workspace member never gets this far: `resolveAgentSendTarget`
 * refuses it first with `AppError("DM_PEER_NOT_IN_WORKSPACE")`, which the route maps with its code.
 */
export class AgentSendRejectedError extends Error {
  readonly status: 400 | 403;

  constructor(status: 400 | 403, message: string) {
    super(message);
    this.name = "AgentSendRejectedError";
    this.status = status;
  }
}
