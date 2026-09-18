import type {
  AgentUserInfo,
  AgentUserInfoMembership,
  AgentUserInfoResponse,
  AgentUserStatus,
} from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "../../../generated/client";
import { agentDisplay } from "../../features/agents/agent-activity-presentation";
import { getAgentDisplay } from "./agent-display.server";
import { parseAgentRuntimeConfig } from "./agent-runtime-config.server";

export type AgentUserInfoErrorBody = { ok: false; errorCode: "user_not_found"; error: string };

export type AgentUserInfoOutcome =
  | { status: 200; body: AgentUserInfoResponse }
  | { status: 404; body: AgentUserInfoErrorBody };

/**
 * Live status + a short `availability` reason, sourced the same way the Workspace Agents list
 * reads it (`agents.functions.ts#listAgents`): the Redis-backed Agent display projection
 * (`agent-display.server.ts`) reduced through `agentDisplay()`, the single online/offline
 * decision the rest of the product reads (see ADR 0038). An Agent with no assigned Computer, or
 * whose display snapshot cannot be read, is reported "unknown" rather than guessed as offline.
 */
export async function resolveAgentStatus(
  workspaceId: string,
  agent: { id: string; computerId: string | null; stoppedAt: Date | null },
): Promise<{ status: AgentUserStatus; availability?: string }> {
  if (!agent.computerId) return { status: "unknown" };
  let snapshot;
  try {
    snapshot = await getAgentDisplay().snapshot({
      workspaceId,
      computerId: agent.computerId,
      agentId: agent.id,
    });
  } catch {
    // An unavailable display read model must not fail the lookup; it only loses the live status.
  }
  const display = agentDisplay(snapshot, { stopped: Boolean(agent.stoppedAt) });
  const status: AgentUserStatus =
    display.kind === "unknown" ? "unknown" : display.isOnline ? "online" : "offline";
  return { status, ...(display.statusDetail ? { availability: display.statusDetail } : {}) };
}

export type ResolvedWorkspaceUser =
  | {
      kind: "human";
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
    }
  | {
      kind: "agent";
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
      computerId: string | null;
      computerName?: string;
      runtime?: string;
      model?: string;
      stoppedAt: Date | null;
      ownerId: string;
    };

/** Finds a human or Agent by Username in one Workspace. Agent names and human usernames are
 * disjoint identifier spaces (see CONTEXT.md), so an Agent match always wins first with no
 * ambiguity in practice. Shared by `user info` and `profile show`. */
export async function findWorkspaceUser(
  db: PrismaClient,
  workspaceId: string,
  name: string,
): Promise<ResolvedWorkspaceUser | undefined> {
  const agent = await db.agent.findFirst({
    where: { workspaceId, name },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      role: true,
      computerId: true,
      stoppedAt: true,
      runtimeConfig: true,
      ownerId: true,
      computer: { select: { name: true, displayName: true } },
    },
  });
  if (agent) {
    let runtime: string | undefined;
    let model: string | undefined;
    try {
      const config = parseAgentRuntimeConfig(agent.runtimeConfig);
      runtime = config.runtime || undefined;
      model = config.model.trim() || undefined;
    } catch {
      // An unparsable runtime config never fails the lookup; it only omits these fields.
    }
    const computerName = agent.computer?.displayName.trim() || agent.computer?.name.trim();
    return {
      kind: "agent",
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      role: agent.role,
      computerId: agent.computerId,
      stoppedAt: agent.stoppedAt,
      ownerId: agent.ownerId,
      ...(computerName ? { computerName } : {}),
      ...(runtime ? { runtime } : {}),
      ...(model ? { model } : {}),
    };
  }
  const membership = await db.workspaceMembership.findFirst({
    where: { workspaceId, user: { username: name } },
    select: {
      role: true,
      user: { select: { id: true, username: true, displayName: true, description: true } },
    },
  });
  if (!membership) return undefined;
  return {
    kind: "human",
    id: membership.user.id,
    name: membership.user.username,
    displayName: membership.user.displayName?.trim() || membership.user.username,
    description: membership.user.description,
    role: membership.role,
  };
}

/** Public channels (every Conversation with a `channelName` is public; see ADR 0024/0025) both
 * the caller and the target currently belong to (`leftAt: null`). Never inspects a channel the
 * caller itself is not a member of, so a channel invisible to the caller can never leak here. */
async function sharedChannelMemberships(
  db: PrismaClient,
  workspaceId: string,
  callerAgentId: string,
  target: { kind: "human" | "agent"; id: string },
): Promise<AgentUserInfoMembership[]> {
  const conversations = await db.conversation.findMany({
    where: {
      workspaceId,
      channelName: { not: null },
      archivedAt: null,
      members: { some: { agentId: callerAgentId, leftAt: null } },
    },
    select: {
      channelName: true,
      members: {
        where:
          target.kind === "agent"
            ? { agentId: target.id, leftAt: null }
            : { userId: target.id, leftAt: null },
        select: { channelRole: true },
      },
    },
  });
  const memberships: AgentUserInfoMembership[] = [];
  for (const conversation of conversations) {
    const membership = conversation.members[0];
    if (!membership || !conversation.channelName) continue;
    memberships.push({ channel: `#${conversation.channelName}`, role: membership.channelRole });
  }
  return memberships;
}

/** Resolves `GET /api/agent/v1/users/:name` (ADR: "user info" placement, see docs/adr/0036).
 * Narrow, visible facts about one human or Agent in the caller's Workspace, plus the public
 * channels both the caller and the target belong to. 404s as `user_not_found` when neither a
 * human nor an Agent of that name exists in the caller's Workspace. */
export async function resolveAgentUserInfo(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  name: string,
): Promise<AgentUserInfoOutcome> {
  const target = await findWorkspaceUser(db, principal.workspaceId, name);
  if (!target)
    return {
      status: 404,
      body: {
        ok: false,
        errorCode: "user_not_found",
        error: `No human or Agent named "${name}" in this Workspace.`,
      },
    };
  const memberships = await sharedChannelMemberships(db, principal.workspaceId, principal.agentId, {
    kind: target.kind,
    id: target.id,
  });
  if (target.kind === "human") {
    const user: AgentUserInfo = {
      kind: "human",
      id: target.id,
      name: target.name,
      displayName: target.displayName,
      description: target.description,
      role: target.role,
      isSelf: false,
    };
    return { status: 200, body: { ok: true, user, memberships } };
  }
  const { status, availability } = await resolveAgentStatus(principal.workspaceId, {
    id: target.id,
    computerId: target.computerId,
    stoppedAt: target.stoppedAt,
  });
  const user: AgentUserInfo = {
    kind: "agent",
    id: target.id,
    name: target.name,
    displayName: target.displayName,
    description: target.description,
    role: target.role,
    isSelf: target.id === principal.agentId,
    ...(target.computerName ? { computerName: target.computerName } : {}),
    ...(target.runtime ? { runtime: target.runtime } : {}),
    ...(target.model ? { model: target.model } : {}),
    status,
    ...(availability ? { availability } : {}),
  };
  return { status: 200, body: { ok: true, user, memberships } };
}
