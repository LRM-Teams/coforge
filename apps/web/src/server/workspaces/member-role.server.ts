import { AppError } from "../../lib/app-error";

export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

export const INVITABLE_WORKSPACE_ROLES = ["admin", "member"] as const;
export type InvitableWorkspaceRole = (typeof INVITABLE_WORKSPACE_ROLES)[number];

export function isWorkspaceMemberRole(value: string): value is WorkspaceMemberRole {
  return (WORKSPACE_MEMBER_ROLES as readonly string[]).includes(value);
}

export function isAdminLike(role: WorkspaceMemberRole): boolean {
  return role === "owner" || role === "admin";
}

export function assertCanManageMembers(actorRole: WorkspaceMemberRole): void {
  if (!isAdminLike(actorRole)) throw new AppError("ACCESS_DENIED");
}

export function normalizeInvitableRole(role: string): InvitableWorkspaceRole {
  if (role === "admin" || role === "member") return role;
  throw new AppError("INVALID_INPUT");
}

export function assertCanInvite(
  actorRole: WorkspaceMemberRole,
  inviteRole: string,
): InvitableWorkspaceRole {
  assertCanManageMembers(actorRole);
  return normalizeInvitableRole(inviteRole);
}

export function assertCanChangeMemberRole(
  actorRole: WorkspaceMemberRole,
  targetRole: WorkspaceMemberRole,
  nextRole: string,
): WorkspaceMemberRole {
  assertCanManageMembers(actorRole);
  if (!isWorkspaceMemberRole(nextRole)) throw new AppError("INVALID_INPUT");
  if (targetRole === "owner" || nextRole === "owner") throw new AppError("CONFLICT");
  return nextRole;
}

export function assertCanRemoveMember(
  actorRole: WorkspaceMemberRole,
  targetRole: WorkspaceMemberRole,
): void {
  assertCanManageMembers(actorRole);
  if (targetRole === "owner") throw new AppError("CONFLICT");
}

export function assertCanLeaveWorkspace(actorRole: WorkspaceMemberRole): void {
  if (actorRole === "owner") throw new AppError("CONFLICT");
}
