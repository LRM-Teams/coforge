/** Thrown by GET loaders when the signed-in User has no WorkspaceMembership. */
export const WORKSPACE_UNAVAILABLE = "No Workspace membership exists for the authenticated user";

export function isWorkspaceUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === WORKSPACE_UNAVAILABLE;
}
