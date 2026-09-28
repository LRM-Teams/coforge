import { VISIBLE_CONVERSATION_WHERE } from "#src/server/conversations/active-member.server";
import type {
  AgentUserInfo,
  AgentUserInfoMembership,
  AgentUserInfoResponse,
  AgentUserStatus,
} from "@lrm/coforge-sdk/agent";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { getAgentDisplay } from "./agent-display.server";
import { parseAgentRuntimeConfig } from "./agent-runtime-config.server";
import {
  agentVisibilityViewerForActor,
  canSeeAgent,
  type AgentVisibilityViewer,
} from "./agent-visibility.server";

export type AgentUserInfoErrorBody =
  | { ok: false; errorCode: "user_not_found"; error: string }
  | { ok: false; errorCode: "agent_not_visible"; error: string };

export type AgentUserInfoOutcome =
  | { status: 200; body: AgentUserInfoResponse }
  | { status: 404; body: AgentUserInfoErrorBody };

/** `findWorkspaceUser`'s distinct answer for a name that resolves to a real, private Agent the
 * viewer cannot see — never conflated with a name that matches nothing at all. */
export const AGENT_NOT_VISIBLE = "agent-not-visible" as const;

/**
 * Live status + a short `availability` reason, sourced the same way the Workspace Agents list
 * reads it (`agents.functions.ts#listAgents`): the Redis-backed Agent display projection
 * (`agent-display.server.ts`) reduced through `agentDisplay()`, the single online/offline
 * decision the rest of the product reads. An Agent with no assigned Computer, or
 * whose display snapshot cannot be read, is reported "unknown" rather than guessed as offline.
 */
export async function resolveAgentStatus(
  workspaceId: string,
  agent: { id: string; computerId: string | null; stoppedAt: Date | null },
): Promise<{ status: AgentUserStatus; availability?: string }> {
  const [only] = await resolveAgentStatuses(workspaceId, [agent]);
  return only;
}

/**
 * The same answer per Agent, for a list, read in one round trip: agent lists (the profile's created
 * Agents, the Agent API's workspace view) are the reason this exists, and a per-Agent display read
 * is one Redis transaction each. A display failure loses every row's live status together rather
 * than one at a time, and still reports "unknown" rather than guessing "offline".
 */
export async function resolveAgentStatuses(
  workspaceId: string,
  agents: ReadonlyArray<{ id: string; computerId: string | null; stoppedAt: Date | null }>,
): Promise<Array<{ status: AgentUserStatus; availability?: string }>> {
  const scoped = agents.filter((agent) => agent.computerId);
  if (scoped.length === 0) return agents.map(() => ({ status: "unknown" as const }));
  type Snapshot = Awaited<ReturnType<ReturnType<typeof getAgentDisplay>["snapshot"]>>;
  const scopeOf = (agent: { computerId: string | null; id: string }) => ({
    workspaceId,
    computerId: agent.computerId as string,
    agentId: agent.id,
  });
  let snapshotByAgentId = new Map<string, Snapshot | undefined>();
  try {
    const snapshots = await getAgentDisplay().snapshotMany(scoped.map(scopeOf));
    snapshotByAgentId = new Map(
      scoped.map((agent, index) => [agent.id, snapshots[index]] as const),
    );
  } catch {
    // The batched read failed as a whole, so fall back to one read per Agent: a single Agent's
    // unreadable display must not blank out every other row's live status, which is the property
    // the Agent API states and this change must not trade away. Only the failure path pays N reads.
    snapshotByAgentId = new Map(
      await Promise.all(
        scoped.map(async (agent) => {
          try {
            return [agent.id, await getAgentDisplay().snapshot(scopeOf(agent))] as const;
          } catch {
            return [agent.id, undefined] as const;
          }
        }),
      ),
    );
  }
  return agents.map((agent) =>
    statusFromDisplay(snapshotByAgentId.get(agent.id), Boolean(agent.stoppedAt)),
  );
}

/** The single online/offline decision, from a display snapshot or its absence. */
function statusFromDisplay(
  snapshot: Awaited<ReturnType<ReturnType<typeof getAgentDisplay>["snapshot"]>> | undefined,
  stopped: boolean,
): { status: AgentUserStatus; availability?: string } {
  const display = agentDisplay(snapshot, { stopped });
  const status: AgentUserStatus =
    display.kind === "unknown" ? "unknown" : display.isOnline ? "online" : "offline";
  return { status, ...(display.statusDetail ? { availability: display.statusDetail } : {}) };
}

/** The original single-Agent body, kept for the callers that read one Agent. */
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
 * disjoint identifier spaces, so an Agent match always wins first with no
 * ambiguity in practice. Shared by `user info` and `profile show`.
 *
 * A private Agent `viewer` cannot see answers the distinct `AGENT_NOT_VISIBLE`
 * sentinel, never conflated with `undefined` (a name that matches nothing at all) — the Web
 * profile panel and the Agent CLI both render the specific "not visible" explanation instead of a
 * generic "not found"; only the human/Agent's other details stay withheld. */
export async function findWorkspaceUser(
  db: PrismaClient,
  workspaceId: string,
  name: string,
  viewer: AgentVisibilityViewer,
): Promise<ResolvedWorkspaceUser | typeof AGENT_NOT_VISIBLE | undefined> {
  const agent = await db.agent.findFirst({
    where: { workspaceId, name, ...ACTIVE_AGENT_WHERE },
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
      visibility: true,
      computer: { select: { name: true, displayName: true } },
    },
  });
  if (agent) {
    if (!canSeeAgent(viewer, agent)) return AGENT_NOT_VISIBLE;
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

/** Public channels (every Conversation with a `channelName` is public) both
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
      ...VISIBLE_CONVERSATION_WHERE,
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

/** Resolves `GET /api/agent/v1/users/:name`.
 * Narrow, visible facts about one human or Agent in the caller's Workspace, plus the public
 * channels both the caller and the target belong to. 404s as `user_not_found` when neither a
 * human nor an Agent of that name exists in the caller's Workspace. */
export async function resolveAgentUserInfo(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  name: string,
): Promise<AgentUserInfoOutcome> {
  const viewer = await agentVisibilityViewerForActor(db, principal.workspaceId, {
    agentId: principal.agentId,
  });
  const target = await findWorkspaceUser(db, principal.workspaceId, name, viewer);
  if (target === AGENT_NOT_VISIBLE)
    return {
      status: 404,
      body: {
        ok: false,
        errorCode: "agent_not_visible",
        error: `@${name} is not visible to you.`,
      },
    };
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
