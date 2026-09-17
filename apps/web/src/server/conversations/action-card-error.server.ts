/**
 * An `action prepare`-specific rejection the HTTP route reports verbatim, with its own status and
 * a machine-readable `error` code — unlike `AppError` (whose codes are shared across many call
 * sites), this class carries the exact shape the CLI/SDK contract promises: a handle miss names
 * its `field`, and a schema/cross-field failure carries the Raft-aligned issue list. Mirrors the
 * narrow-class pattern in `agent-send-rejected-error.server.ts`.
 */
export type ActionCardErrorCode =
  | "INVALID_ACTION"
  | "INVALID_HANDLE"
  | "CHANNEL_EXISTS"
  | "AGENT_EXISTS";

export class ActionCardError extends Error {
  readonly status: 409 | 422;
  readonly code: ActionCardErrorCode;
  readonly field?: string;
  /** Only set for a zod/cross-field validation failure: one `<path>: <message>` string per issue. */
  readonly issues?: string[];

  constructor(
    status: 409 | 422,
    code: ActionCardErrorCode,
    message: string,
    options: { field?: string; issues?: string[] } = {},
  ) {
    super(message);
    this.name = "ActionCardError";
    this.status = status;
    this.code = code;
    this.field = options.field;
    this.issues = options.issues;
  }
}
