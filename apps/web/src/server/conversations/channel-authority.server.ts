import type { PrismaClient } from "../../../generated/client";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import type { ChannelActor } from "./public-channels.server";
import { isElevatedServerRole } from "../workspaces/member-role.server";
import { ACTIVE_AGENT_WHERE } from "../agents/active-agent.server";

/**
 * Channel-level roles and capability computation (ADR 0030, superseding ADR 0024's
 * `agentHasAdminAuthority` authority table for `update`/`archive`/`unarchive`/`remove-member`).
 *
 * Two independent authority sources feed every gated channel operation:
 * - "server role": the actor's Workspace-level role for a human (`WorkspaceMembership.role`) or
 *   an Agent's own server role (`Agent.role`), both `owner | admin | member`.
 * - "channel role": `ConversationMember.channelRole`, stored on the membership row itself,
 *   `admin | member`.
 *
 * Admin basis is computed, never stored: `server_role` when the actor's server role is
 * owner/admin; otherwise `channel_role` when the membership's `channelRole` is `admin`;
 * otherwise none. When both apply, `server_role` is reported (matches Raft's `channelAdminBasis`).
 */
export const CHANNEL_ROLES = ["admin", "member"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export function isChannelRole(value: string): value is ChannelRole {
  return (CHANNEL_ROLES as readonly string[]).includes(value);
}

export type ChannelAdminBasis = "server_role" | "channel_role";

export const CHANNEL_CAPABILITIES = [
  "post",
  "leave",
  "add_member",
  "update",
  "archive",
  "unarchive",
  "remove_member",
  "manage_roles",
] as const;
export type ChannelCapability = (typeof CHANNEL_CAPABILITIES)[number];
export type ChannelCapabilities = Record<ChannelCapability, boolean>;

/** Pure: which basis (if any) makes the actor a channel admin, given their server role and
 * their own membership's stored channel role. `server_role` wins when both apply. */
export function deriveChannelAdminBasis(
  serverRole: string | undefined,
  channelRole: string | undefined,
): ChannelAdminBasis | undefined {
  if (isElevatedServerRole(serverRole)) return "server_role";
  if (channelRole === "admin") return "channel_role";
  return undefined;
}

/**
 * Pure: the capability matrix for one actor in one channel.
 * - Active membership alone grants `post`, `leave` (never on `#general`), `add_member`
 *   (ADR 0025) — independent of admin basis.
 * - Either admin basis additionally grants `update`, `archive`, `unarchive`, `remove_member`
 *   (never on `#general`, and independent of active membership: a server admin who is not a
 *   channel member can still archive it).
 * - `manage_roles` is human-only (Agents never change channel roles; there is no Agent command
 *   for it) and requires an admin basis, never on `#general` (nobody can be channel admin there,
 *   so there is nothing to manage).
 */
export function deriveChannelCapabilities(input: {
  isHuman: boolean;
  isActiveMember: boolean;
  isGeneral: boolean;
  adminBasis: ChannelAdminBasis | undefined;
}): ChannelCapabilities {
  const isAdmin = input.adminBasis !== undefined;
  return {
    post: input.isActiveMember,
    leave: input.isActiveMember && !input.isGeneral,
    add_member: input.isActiveMember,
    update: isAdmin && !input.isGeneral,
    archive: isAdmin && !input.isGeneral,
    unarchive: isAdmin && !input.isGeneral,
    remove_member: isAdmin && !input.isGeneral,
    manage_roles: input.isHuman && isAdmin && !input.isGeneral,
  };
}

/** A `ConversationMember` `where` clause identifying `actor`'s own row in a channel. Shared by
 * `PublicChannels` (which otherwise duplicated this as a private method) and this module. */
export function channelActorMemberWhere(actor: ChannelActor) {
  return "userId" in actor ? { userId: actor.userId } : { agentId: actor.agentId };
}

/** The actor's own server role: a human's Workspace role, or an Agent's own `role` column.
 * `undefined` when the actor has no Workspace membership/Agent row at all (should not happen
 * for an already-authorized actor, but callers must not crash on it). */
export async function resolveActorServerRole(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  actor: ChannelActor,
): Promise<string | undefined> {
  if ("userId" in actor) {
    const membership = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
      select: { role: true },
    });
    return membership?.role;
  }
  const agent = await db.agent.findFirst({
    where: { id: actor.agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { role: true },
  });
  return agent?.role;
}

export type ChannelAuthority = {
  isActiveMember: boolean;
  serverRole: string | undefined;
  channelRole: string | undefined;
  adminBasis: ChannelAdminBasis | undefined;
  capabilities: ChannelCapabilities;
};

/**
 * The full, per-actor, per-channel authority: whether the actor is presently an active member,
 * their server/channel roles, the derived admin basis, and the resulting capability matrix. The
 * single seam every gated channel operation (human or Agent) reads instead of re-deriving
 * authority ad hoc.
 */
export async function resolveChannelAuthority(
  db: PrismaClient,
  workspaceId: string,
  actor: ChannelActor,
  channel: { id: string; channelName: string | null },
): Promise<ChannelAuthority> {
  const [serverRole, membership] = await Promise.all([
    resolveActorServerRole(db, workspaceId, actor),
    db.conversationMember.findFirst({
      where: {
        conversationId: channel.id,
        ...channelActorMemberWhere(actor),
        ...ACTIVE_MEMBER_WHERE,
      },
      select: { channelRole: true },
    }),
  ]);
  const isActiveMember = Boolean(membership);
  const adminBasis = deriveChannelAdminBasis(serverRole, membership?.channelRole);
  const capabilities = deriveChannelCapabilities({
    isHuman: "userId" in actor,
    isActiveMember,
    isGeneral: channel.channelName === "general",
    adminBasis,
  });
  return {
    isActiveMember,
    serverRole,
    channelRole: membership?.channelRole,
    adminBasis,
    capabilities,
  };
}

/** Convenience for the three Agent operations ADR 0024 gated on `agentHasAdminAuthority`
 * (`update`, `archive`/`unarchive`, `remove-member`), now channel-aware: the acting Agent has
 * authority when either basis applies on this specific channel (ADR 0030). */
export async function hasChannelAdminAuthority(
  db: PrismaClient,
  workspaceId: string,
  actor: ChannelActor,
  channel: { id: string; channelName: string | null },
): Promise<boolean> {
  const authority = await resolveChannelAuthority(db, workspaceId, actor, channel);
  return authority.adminBasis !== undefined;
}
