import {
  encodeAgentContextScanRequest,
  RUNTIME_PROVIDER,
  type AgentContextScanRequest,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "../../../generated/client";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { parseAgentRuntimeConfig } from "./agent-runtime-config.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  type CentrifugoServerApi,
} from "../centrifugo/server-api.server";
import {
  getAgentContextCache,
  type AgentContextCache,
  type AgentContextReadResult,
} from "../centrifugo/agent-context-cache.server";
import { getComputerStatusCache } from "../centrifugo/computer-status.server";

export type AgentContextViewer = { userId: string; workspaceId: string };

/** The Computer/launch/session scope one context scan runs against, resolved from the Agent's own
 * record. `launchId`/`sessionId` are what the server currently believes is live; the daemon
 * re-checks both against its own state before running anything (ADR 0051). */
export type AgentContextAssignment = {
  computerId: string;
  provider: string;
  launchId: string;
  sessionId: string;
};

export type AgentContextReadResponse =
  | { status: "ready"; read: AgentContextReadResult }
  | { status: "unavailable" };

/** Reads the last stored context-composition report for one Agent the viewer owns. Same
 * ownership rule as `findOwnedSkillsAssignment`: the Agent must belong to the viewer's Workspace,
 * be owned by the viewer, and have a Computer the viewer's Workspace is connected to. */
export async function readAgentContextReport(
  db: PrismaClient,
  viewer: AgentContextViewer,
  agentId: string,
  cache: AgentContextCache = getAgentContextCache(),
): Promise<AgentContextReadResponse> {
  const assignment = await findAgentContextAssignment(db, viewer, agentId);
  if (!assignment) return { status: "unavailable" };
  return {
    status: "ready",
    read: await cache.read({
      workspaceId: viewer.workspaceId,
      computerId: assignment.computerId,
      agentId,
    }),
  };
}

/**
 * Asks the Agent's Computer for a fresh context-window composition (ADR 0051). Gated on the same
 * ownership rule as the read path plus the Computer being online; the daemon re-checks the
 * launch/session itself, so a request naming a launch the daemon has already superseded is
 * refused there without running the CLI. The previous report stays readable through
 * `readAgentContextReport` the whole time.
 */
export async function scanAgentContextReport(
  db: PrismaClient,
  viewer: AgentContextViewer,
  agentId: string,
  events: Pick<CentrifugoServerApi, "publish"> = createCentrifugoServerApi(),
  cache: AgentContextCache = getAgentContextCache(),
  online: (scope: { workspaceId: string; computerId: string }) => Promise<boolean> = (scope) =>
    getComputerStatusCache().get(scope),
): Promise<{ scanId: string } | { status: "unavailable" | "offline" }> {
  const assignment = await findAgentContextAssignment(db, viewer, agentId);
  if (!assignment) return { status: "unavailable" };
  if (!(await online({ workspaceId: viewer.workspaceId, computerId: assignment.computerId })))
    return { status: "offline" };
  const request: AgentContextScanRequest = {
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: viewer.workspaceId,
    computerId: assignment.computerId,
    agentId,
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    launchId: assignment.launchId,
    sessionId: assignment.sessionId,
  };
  await cache.putScan({
    workspaceId: viewer.workspaceId,
    computerId: assignment.computerId,
    agentId,
    scanId: request.requestId,
    status: "pending",
  });
  await events.publish(
    daemonControlChannel(viewer.workspaceId, assignment.computerId),
    encodeAgentContextScanRequest(request),
  );
  return { scanId: request.requestId };
}

/** Ownership + scope: the Agent must be live in the viewer's Workspace, owned by the viewer, and
 * carry a Claude Code runtime on a Computer that Workspace is connected to. The launch/session
 * come from the Agent's own persisted session reference — what the server currently believes is
 * live, and only ever a suggestion the daemon validates against its own state. */
async function findAgentContextAssignment(
  db: PrismaClient,
  viewer: AgentContextViewer,
  agentId: string,
): Promise<AgentContextAssignment | undefined> {
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId: viewer.workspaceId,
      ownerId: viewer.userId,
      workspace: { members: { some: { userId: viewer.userId } } },
      computer: { workspaces: { some: { workspaceId: viewer.workspaceId } } },
      ...ACTIVE_AGENT_WHERE,
    },
    select: {
      computerId: true,
      runtimeConfig: true,
      runtimeSession: true,
      currentSession: { select: { nativeSessionId: true, state: true } },
    },
  });
  if (!agent?.computerId) return undefined;
  // parseAgentRuntimeConfig throws on a malformed persisted config; an unreadable Agent is not a
  // context-scan candidate, and the failure must not take the whole read down.
  let runtime;
  try {
    runtime = parseAgentRuntimeConfig(agent.runtimeConfig).runtime;
  } catch {
    return undefined;
  }
  if (runtime !== RUNTIME_PROVIDER.CLAUDE_CODE) return undefined;
  const reference = (agent.runtimeSession ?? null) as {
    launchId?: unknown;
  } | null;
  return {
    computerId: agent.computerId,
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    launchId: typeof reference?.launchId === "string" ? reference.launchId : "",
    sessionId: agent.currentSession?.nativeSessionId ?? "",
  };
}
