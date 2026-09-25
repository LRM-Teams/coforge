import { isAppError } from "#src/lib/app-error";

/**
 * Maps a target-resolution failure to the Agent API's status contract. `resolveAgentTarget`
 * (and the private helpers it calls) throws `AppError("INVALID_INPUT")` for a malformed
 * `#channel`, `AppError("ACCESS_DENIED")` for a channel the Agent is not a member of, and a
 * plain `Error` (`"invalid message target"`, `"target user not found"`,
 * `"conversation scope is not authorized"`) for the `@user` grammar and DM authorization.
 *
 * Shared by the attachment upload and attachment-upload-session routes, so the contract is stated
 * once instead of a copy mirrored between them.
 */
export function targetResolutionStatus(error: unknown): number {
  if (isAppError(error)) return error.code === "ACCESS_DENIED" ? 403 : 400;
  if (error instanceof Error && error.message === "invalid message target") return 400;
  // "target user not found" / "conversation scope is not authorized": an unknown target or one
  // the Agent cannot reach reads the same to the caller as "not a member".
  return 403;
}
