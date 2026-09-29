import { isAppError } from "#src/lib/app-error";
import { errorResponse } from "./agent-http-error.server";

/**
 * Maps a target-resolution failure to the Agent API's status contract. Resolving a target throws
 * `AppError("INVALID_INPUT")` for a malformed `#channel`, `AppError("ACCESS_DENIED")` for a
 * channel the Agent is not a member of, `AppError("DM_PEER_NOT_IN_WORKSPACE")` for a direct
 * message whose person has left (answered by `dmPeerNotInWorkspaceResponse`, not here), and a
 * plain `Error` for the `@user` grammar (`"invalid message target"`) and for a username that does
 * not exist or belongs to no member this Agent can reach (`"target user not found"`, and
 * `"conversation scope is not authorized"` for an Agent outside the Workspace).
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

/**
 * `target is not accessible`: the one answer to a target this Agent cannot use, the same for a
 * username that does not exist and for someone outside the Workspace, so it reveals neither.
 */
export function targetNotAccessibleResponse(status: number) {
  return errorResponse("TARGET_NOT_ACCESSIBLE", "target is not accessible", status, false);
}

/**
 * The answer to an Agent posting to an `@user` it cannot reach: a username that does not exist or
 * someone outside the Workspace it never had a direct message with. The message route answers it
 * the way the attachment routes do. Undefined for any other error.
 */
function unknownTargetUserResponse(error: unknown) {
  if (!(error instanceof Error) || error.message !== "target user not found") return undefined;
  return targetNotAccessibleResponse(403);
}

/**
 * The answer to an Agent posting (a message or an attachment) to a direct message whose person is
 * not a member of the Workspace: `resolveAgentSendTarget` refuses it with
 * `DM_PEER_NOT_IN_WORKSPACE`. Undefined for any other error.
 */
export function dmPeerNotInWorkspaceResponse(error: unknown, target: string) {
  if (!isAppError(error) || error.code !== "DM_PEER_NOT_IN_WORKSPACE") return undefined;
  return errorResponse(
    error.code,
    `${target.split(":")[0]} is not a member of this Workspace, so this Agent cannot send them a direct message`,
    403,
    false,
  );
}

/**
 * The answer to an Agent posting a message or an action card to a target it cannot reach: a
 * person who left (`DM_PEER_NOT_IN_WORKSPACE`), or an unknown username and someone outside the
 * Workspace, which read alike (`target is not accessible`). Undefined for any other error.
 */
export function postingTargetRefusalResponse(error: unknown, target: string) {
  return dmPeerNotInWorkspaceResponse(error, target) ?? unknownTargetUserResponse(error);
}
