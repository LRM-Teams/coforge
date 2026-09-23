import type {
  AgentProfileCreatedAgent,
  AgentProfileCreator,
  AgentProfileView,
} from "@lrm/coforge-sdk/agent";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import type { PrismaClient } from "../../../generated/client";
import { AGENT_DISPLAY_NAME_MAX_LENGTH } from "../../features/agents/agent.schemas";
import { AGENT_NOT_VISIBLE, findWorkspaceUser, resolveAgentStatus } from "./agent-user-info.server";
import {
  agentVisibilityViewerForActor,
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "./agent-visibility.server";

/** Same cap as `agentInputShape.description` (`agent.schemas.ts`), reused here so an Agent's
 * self-service profile description and its owner's full Agent-edit form never disagree. */
export const AGENT_PROFILE_DESCRIPTION_MAX_LENGTH = 500;

export type AgentProfileErrorBody =
  | { ok: false; errorCode: "user_not_found"; error: string }
  | { ok: false; errorCode: "agent_not_visible"; error: string };
export type AgentProfileShowOutcome =
  | { status: 200; body: { ok: true; profile: AgentProfileView } }
  | { status: 404; body: AgentProfileErrorBody };

export type AgentProfileUpdateErrorBody = {
  ok: false;
  errorCode: "profile_invalid";
  error: string;
};
export type AgentProfileUpdateOutcome =
  | { status: 200; body: { ok: true; profile: AgentProfileView & { kind: "agent" } } }
  | { status: 400; body: AgentProfileUpdateErrorBody };

function invalidProfileUpdate(error: string): AgentProfileUpdateOutcome {
  return { status: 400, body: { ok: false, errorCode: "profile_invalid", error } };
}

/** Agents this human owns (`Agent.ownerId`), each with its live status. CoForge Agents can never
 * own another Agent (`Agent.ownerId` always references a human `User`), so this is
 * only ever populated for a human profile view — an Agent's own view never carries it.
 *
 * Filtered by the CALLER's own visibility, not the profile owner's — a private Agent
 * this human created is listed back to themself (or to an owner/admin), but stays absent from
 * this same list shown to any other caller. */
export async function createdAgentsFor(
  db: PrismaClient,
  workspaceId: string,
  ownerId: string,
  viewer: AgentVisibilityViewer,
): Promise<AgentProfileCreatedAgent[]> {
  const owned = await db.agent.findMany({
    where: { workspaceId, ownerId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(viewer) },
    select: { id: true, name: true, displayName: true, computerId: true, stoppedAt: true },
    orderBy: { name: "asc" },
  });
  return Promise.all(
    owned.map(async (agent) => {
      const { status } = await resolveAgentStatus(workspaceId, agent);
      return { name: agent.name, displayName: agent.displayName, status };
    }),
  );
}

async function creatorFor(db: PrismaClient, ownerId: string): Promise<AgentProfileCreator | null> {
  const owner = await db.user.findUnique({
    where: { id: ownerId },
    select: { username: true, displayName: true },
  });
  if (!owner) return null;
  return { name: owner.username, displayName: owner.displayName?.trim() || owner.username };
}

async function buildProfileView(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  target: Exclude<
    NonNullable<Awaited<ReturnType<typeof findWorkspaceUser>>>,
    typeof AGENT_NOT_VISIBLE
  >,
  viewer: AgentVisibilityViewer,
): Promise<AgentProfileView> {
  if (target.kind === "human") {
    return {
      kind: "human",
      id: target.id,
      name: target.name,
      displayName: target.displayName,
      description: target.description,
      role: target.role,
      isSelf: false,
      createdAgents: await createdAgentsFor(db, principal.workspaceId, target.id, viewer),
    };
  }
  const [{ status, availability }, creator] = await Promise.all([
    resolveAgentStatus(principal.workspaceId, {
      id: target.id,
      computerId: target.computerId,
      stoppedAt: target.stoppedAt,
    }),
    creatorFor(db, target.ownerId),
  ]);
  return {
    kind: "agent",
    id: target.id,
    name: target.name,
    displayName: target.displayName,
    description: target.description,
    role: target.role,
    isSelf: target.id === principal.agentId,
    runtime: target.runtime ?? "",
    model: target.model ?? "",
    ...(target.computerName ? { computerName: target.computerName } : {}),
    status,
    ...(availability ? { availability } : {}),
    creator,
  };
}

/** Resolves `GET /api/agent/v1/profile[?target=<name>]`. Defaults to the calling Agent's own
 * profile when `target` is omitted. */
export async function resolveAgentProfileShow(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  target: string | undefined,
): Promise<AgentProfileShowOutcome> {
  const viewer = await agentVisibilityViewerForActor(db, principal.workspaceId, {
    agentId: principal.agentId,
  });
  if (!target) {
    // Self is looked up by id, not by name (an Agent's own Username is always known already).
    const selfAgent = await db.agent.findUnique({
      where: { id_workspaceId: { id: principal.agentId, workspaceId: principal.workspaceId } },
      select: { name: true, deletedAt: true },
    });
    // A deleted Agent has no profile; its key is already refused at authentication.
    if (!selfAgent || selfAgent.deletedAt)
      return {
        status: 404,
        body: {
          ok: false,
          errorCode: "user_not_found",
          error: "Calling Agent record was not found.",
        },
      };
    target = selfAgent.name;
  }
  const resolved = await findWorkspaceUser(db, principal.workspaceId, target, viewer);
  if (resolved === AGENT_NOT_VISIBLE)
    return {
      status: 404,
      body: {
        ok: false,
        errorCode: "agent_not_visible",
        error: `@${target} is not visible to you.`,
      },
    };
  if (!resolved)
    return {
      status: 404,
      body: {
        ok: false,
        errorCode: "user_not_found",
        error: `No human or Agent named "${target}" in this Workspace.`,
      },
    };
  const profile = await buildProfileView(db, principal, resolved, viewer);
  return { status: 200, body: { ok: true, profile } };
}

/** Resolves `POST /api/agent/v1/profile`. Applies only to the calling Agent (self); the Username
 * is fixed at creation and is never accepted here (see PR #310). */
export async function resolveAgentProfileUpdate(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  input: { displayName?: unknown; description?: unknown },
): Promise<AgentProfileUpdateOutcome> {
  const hasDisplayName = input.displayName !== undefined;
  const hasDescription = input.description !== undefined;
  if (!hasDisplayName && !hasDescription)
    return {
      status: 400,
      body: {
        ok: false,
        errorCode: "profile_invalid",
        error: "Provide at least one of displayName or description.",
      },
    };
  let displayName: string | undefined;
  if (hasDisplayName) {
    if (typeof input.displayName !== "string")
      return invalidProfileUpdate("displayName must be a string.");
    displayName = input.displayName.trim();
    if (displayName.length === 0) return invalidProfileUpdate("displayName must not be empty.");
    if (displayName.length > AGENT_DISPLAY_NAME_MAX_LENGTH)
      return invalidProfileUpdate(
        `displayName must be at most ${AGENT_DISPLAY_NAME_MAX_LENGTH} characters.`,
      );
  }
  let description: string | undefined;
  if (hasDescription) {
    if (typeof input.description !== "string")
      return invalidProfileUpdate("description must be a string.");
    description = input.description.trim();
    if (description.length > AGENT_PROFILE_DESCRIPTION_MAX_LENGTH)
      return invalidProfileUpdate(
        `description must be at most ${AGENT_PROFILE_DESCRIPTION_MAX_LENGTH} characters.`,
      );
  }
  const agent = await db.agent.update({
    where: { id_workspaceId: { id: principal.agentId, workspaceId: principal.workspaceId } },
    data: {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    select: { name: true },
  });
  // Self-service: an Agent updating its own profile always sees the result it just wrote back
  // (the "same creator" visibility rule covers an Agent seeing itself), never a second membership
  // lookup beyond the one `agentVisibilityViewerForActor` already makes.
  const viewer = await agentVisibilityViewerForActor(db, principal.workspaceId, {
    agentId: principal.agentId,
  });
  const resolved = await findWorkspaceUser(db, principal.workspaceId, agent.name, viewer);
  if (!resolved || resolved === AGENT_NOT_VISIBLE || resolved.kind !== "agent")
    return invalidProfileUpdate("Updated Agent profile could not be re-read.");
  const profile = await buildProfileView(db, principal, resolved, viewer);
  if (profile.kind !== "agent")
    return invalidProfileUpdate("Updated Agent profile could not be re-read.");
  return { status: 200, body: { ok: true, profile } };
}
