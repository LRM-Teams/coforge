import { AppError } from "#src/lib/app-error";

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

/** An actor's stored server role (human `WorkspaceMembership.role` or `Agent.role`) counts as
 * owner/admin only when it is a recognized role; a missing or unknown value fails closed. */
export function isElevatedServerRole(role: string | undefined): boolean {
  return role !== undefined && isWorkspaceMemberRole(role) && isAdminLike(role);
}

/** Workspace-wide settings, such as hiding `#general`, are Workspace owner/admin only. */
export function assertCanManageWorkspaceSettings(actorRole: string | undefined): void {
  if (!isElevatedServerRole(actorRole)) throw new AppError("ACCESS_DENIED");
}

export function assertCanManageMembers(actorRole: WorkspaceMemberRole): void {
  if (!isAdminLike(actorRole)) throw new AppError("ACCESS_DENIED");
}

/** Creating an Agent requires Workspace owner/admin authority, kept as its own named seam. */
export function assertCanCreateAgents(actorRole: WorkspaceMemberRole): void {
  if (!isAdminLike(actorRole)) throw new AppError("ACCESS_DENIED");
}

/**
 * Raft capability table (`shared/src/serverPermissions.ts`): `deleteAgents` sits with
 * `createAgents`/`editAgents` in `ADMIN_SERVER_CAPABILITIES` and is absent from
 * `MEMBER_SERVER_CAPABILITIES`, so deleting an Agent is Workspace owner/admin only — not even the
 * Agent's own owner may delete it as a plain member.
 */
export function assertCanDeleteAgents(actorRole: WorkspaceMemberRole): void {
  if (!isAdminLike(actorRole)) throw new AppError("ACCESS_DENIED");
}

/**
 * Raft capability table (`shared/src/serverPermissions.ts`): `controlAgentRuntime` is held by
 * the server owner, admin, and every plain member; `resetAgentWorkspace` is owner/admin only.
 * Named seam for `AgentControl.execute()`'s user-initiated Restart/Reset session/Full reset
 * authorization — not a general capability framework.
 */
export const AGENT_CONTROL_CAPABILITIES = ["controlAgentRuntime", "resetAgentWorkspace"] as const;
export type AgentControlCapability = (typeof AGENT_CONTROL_CAPABILITIES)[number];

export function hasAgentControlCapability(
  actorRole: WorkspaceMemberRole,
  capability: AgentControlCapability,
): boolean {
  return capability === "controlAgentRuntime" ? true : isAdminLike(actorRole);
}

export function assertHasAgentControlCapability(
  actorRole: WorkspaceMemberRole,
  capability: AgentControlCapability,
): void {
  if (!hasAgentControlCapability(actorRole, capability)) throw new AppError("ACCESS_DENIED");
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
