import type { Prisma, PrismaClient } from "../../../generated/client";
import { AGENT_VISIBILITY } from "../../features/agents/agent-visibility";
import { AppError } from "../../lib/app-error";
import { resolveActorServerRole } from "../conversations/channel-authority.server";
import { isElevatedServerRole } from "../workspaces/member-role.server";

/**
 * Who is asking whether they may see a given Agent (ADR 0059): a human Workspace member, or
 * another Agent acting through the Agent CLI/API. Carries what `canSeeAgent` and
 * `visibleAgentWhere` need (plus the acting Agent's own id) — never a full `User`/`Agent` row — so a caller that already
 * authenticated an actor never has to re-fetch one to answer a visibility question.
 *
 * `role` is the viewer's own server role (a human's `WorkspaceMembership.role`, or an Agent's
 * own `Agent.role`; ADR 0024) exactly as `resolveActorServerRole` returns it: `undefined` when
 * the actor has no membership/Agent row, and never assumed to be a recognized
 * `WorkspaceMemberRole` — `isElevatedServerRole` fails closed on anything else.
 */
export type AgentVisibilityViewer =
  | { kind: "user"; userId: string; role: string | undefined }
  | { kind: "agent"; agentId: string; ownerId: string; role: string | undefined };

/** The Workspace-member id a private Agent must be owned by for `viewer` to count as its
 * creator: the human's own id, or the acting Agent's own `ownerId` (ADR 0059 — "same creator"
 * includes the Agent seeing itself). */
function viewerCreatorId(viewer: AgentVisibilityViewer): string {
  return viewer.kind === "user" ? viewer.userId : viewer.ownerId;
}

/**
 * Build the viewer for a human Workspace member, reusing the same server-role lookup
 * `resolveChannelAuthority` already performs (`resolveActorServerRole`) instead of adding a
 * second `WorkspaceMembership` query.
 */
export async function agentVisibilityViewerForUser(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  userId: string,
): Promise<AgentVisibilityViewer> {
  const role = await resolveActorServerRole(db, workspaceId, { userId });
  return { kind: "user", userId, role };
}

/**
 * Build the viewer for an Agent principal a caller already resolved — its own id, its
 * `ownerId`, and its server role — never a second `Agent` row query of its own.
 */
export function agentVisibilityViewerForAgent(agent: {
  id: string;
  ownerId: string;
  role: string | undefined;
}): AgentVisibilityViewer {
  return { kind: "agent", agentId: agent.id, ownerId: agent.ownerId, role: agent.role };
}

/**
 * Pure in-memory check: can `viewer` see `agent`? A public Agent is visible to everyone in the
 * Workspace; anything else — `"private"`, or an unrecognized value, since the column is a plain
 * `String` rather than a database enum — is visible only to its own creator, another Agent
 * sharing that same creator, or a viewer whose own server role is owner/admin (ADR 0059's rule
 * table). Fails closed the same way `visibleAgentWhere` does, so the two never disagree on a row.
 */
export function canSeeAgent(
  viewer: AgentVisibilityViewer,
  agent: { visibility: string; ownerId: string },
): boolean {
  if (agent.visibility === AGENT_VISIBILITY.PUBLIC) return true;
  if (isElevatedServerRole(viewer.role)) return true;
  return viewerCreatorId(viewer) === agent.ownerId;
}

/**
 * The `Prisma.AgentWhereInput` fragment meant to be composed with `ACTIVE_AGENT_WHERE` (and any
 * other scope) on every Agent list/query: `{}` for an owner/admin-like viewer, since there is
 * nothing to hide from them; otherwise "public, or mine", so a private Agent never appears in a
 * list to anyone else. Must agree with `canSeeAgent` row for row — the unit tests assert exactly
 * that agreement, not just each function in isolation.
 */
export function visibleAgentWhere(viewer: AgentVisibilityViewer): Prisma.AgentWhereInput {
  if (isElevatedServerRole(viewer.role)) return {};
  return {
    OR: [{ visibility: AGENT_VISIBILITY.PUBLIC }, { ownerId: viewerCreatorId(viewer) }],
  };
}

/**
 * Refuse a lookup aimed at an Agent `viewer` is not allowed to see (ADR 0059). Callers that
 * resolve an Agent by id/name/handle call this right after loading the row. The answer names
 * only the fact that the viewer cannot see it (the profile panel says so); it carries none of
 * the Agent's details.
 */
export function assertAgentVisible(
  viewer: AgentVisibilityViewer,
  agent: { visibility: string; ownerId: string },
): void {
  if (!canSeeAgent(viewer, agent)) throw new AppError("AGENT_NOT_VISIBLE");
}
