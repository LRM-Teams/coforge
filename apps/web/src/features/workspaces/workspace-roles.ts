export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

/** The roles with Workspace owner/admin authority. */
export const WORKSPACE_ADMIN_ROLES = [
  "owner",
  "admin",
] as const satisfies readonly WorkspaceMemberRole[];

/** Whether a stored role is a Workspace owner or admin; any other or missing role fails closed. */
export function isWorkspaceAdminRole(role: string | undefined): boolean {
  return WORKSPACE_ADMIN_ROLES.some((admin) => admin === role);
}

/** Whether a Workspace member's role manages Workspace-wide settings, such as its profile. */
export function canManageWorkspaceSettings(role: string | undefined): boolean {
  return isWorkspaceAdminRole(role);
}

/** Whether a Workspace member's role invites members, changes their roles and removes them. */
export function canManageMembers(role: string | undefined): boolean {
  return isWorkspaceAdminRole(role);
}

/** Whether a Workspace member may leave it: anyone but its owner. */
export function canLeaveWorkspace(role: string | undefined): boolean {
  return role !== undefined && role !== "owner";
}
