import type {
  AgentWorkspaceFileReadRequest,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListRequest,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "@/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";

export type WorkspaceFilesViewer = { userId: string; workspaceId: string };
export type WorkspaceFilesAssignment = { computerId: string; revision: string };

export type PendingWorkspaceFilesList = {
  request: AgentWorkspaceFilesListRequest;
  userId: string;
  revision: string;
};
export type PendingWorkspaceFileRead = {
  request: AgentWorkspaceFileReadRequest;
  userId: string;
  revision: string;
};

export interface AgentWorkspaceFilesListResults {
  begin(pending: PendingWorkspaceFilesList): Promise<void>;
  read(requestId: string): Promise<AgentWorkspaceFilesListResult | undefined>;
  clear(requestId: string): Promise<void>;
}
export interface AgentWorkspaceFileReadResults {
  begin(pending: PendingWorkspaceFileRead): Promise<void>;
  read(requestId: string): Promise<AgentWorkspaceFileReadResult | undefined>;
  clear(requestId: string): Promise<void>;
}

type WorkspaceFilesListResponse =
  | { status: "ready"; result: AgentWorkspaceFilesListResult }
  | { status: "offline" | "timeout" | "unavailable" };
type WorkspaceFileReadResponse =
  | { status: "ready"; result: AgentWorkspaceFileReadResult }
  | { status: "offline" | "timeout" | "unavailable" };

/** Authorizes a fresh directory/file observation, not Computer inventory or session state. Same
 * publish/poll/timeout shape as `AgentSkillsQuery`, with two operations instead of one. */
export class AgentWorkspaceFilesQuery {
  constructor(
    private readonly dependencies: {
      findOwned(
        viewer: WorkspaceFilesViewer,
        agentId: string,
      ): Promise<WorkspaceFilesAssignment | undefined>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      publishList(request: AgentWorkspaceFilesListRequest): Promise<void>;
      publishRead(request: AgentWorkspaceFileReadRequest): Promise<void>;
      listResults: AgentWorkspaceFilesListResults;
      readResults: AgentWorkspaceFileReadResults;
    },
    private readonly timing = { now: Date.now, wait: () => Bun.sleep(100), timeoutMs: 5_000 },
  ) {}

  async list(
    viewer: WorkspaceFilesViewer,
    agentId: string,
    dirPath: string,
    includeHidden: boolean,
  ): Promise<WorkspaceFilesListResponse> {
    const { findOwned, online, publishList, listResults } = this.dependencies;
    const assignment = await findOwned(viewer, agentId);
    if (!assignment) return { status: "unavailable" };
    const request: AgentWorkspaceFilesListRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: assignment.computerId,
      agentId,
      dirPath,
      includeHidden,
    };
    try {
      if (!(await online(request))) return { status: "offline" };
      await listResults.begin({ request, userId: viewer.userId, revision: assignment.revision });
      await publishList(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      do {
        const result = await listResults.read(request.requestId);
        if (result) {
          const current = await findOwned(viewer, agentId);
          if (
            !current ||
            current.computerId !== assignment.computerId ||
            current.revision !== assignment.revision ||
            !sameWorkspaceFilesListScope(request, result)
          )
            return { status: "unavailable" };
          return { status: "ready", result };
        }
        await this.timing.wait();
      } while (this.timing.now() < deadline);
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await listResults.clear(request.requestId).catch(() => {});
    }
  }

  async read(
    viewer: WorkspaceFilesViewer,
    agentId: string,
    path: string,
  ): Promise<WorkspaceFileReadResponse> {
    const { findOwned, online, publishRead, readResults } = this.dependencies;
    const assignment = await findOwned(viewer, agentId);
    if (!assignment) return { status: "unavailable" };
    const request: AgentWorkspaceFileReadRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: assignment.computerId,
      agentId,
      path,
    };
    try {
      if (!(await online(request))) return { status: "offline" };
      await readResults.begin({ request, userId: viewer.userId, revision: assignment.revision });
      await publishRead(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      do {
        const result = await readResults.read(request.requestId);
        if (result) {
          const current = await findOwned(viewer, agentId);
          if (
            !current ||
            current.computerId !== assignment.computerId ||
            current.revision !== assignment.revision ||
            !sameWorkspaceFileReadScope(request, result)
          )
            return { status: "unavailable" };
          return { status: "ready", result };
        }
        await this.timing.wait();
      } while (this.timing.now() < deadline);
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await readResults.clear(request.requestId).catch(() => {});
    }
  }
}

export function sameWorkspaceFilesListScope(
  a: AgentWorkspaceFilesListRequest,
  b: AgentWorkspaceFilesListRequest,
) {
  return (
    a.protocolMajor === b.protocolMajor &&
    a.requestId === b.requestId &&
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId &&
    a.dirPath === b.dirPath &&
    a.includeHidden === b.includeHidden
  );
}

export function sameWorkspaceFileReadScope(
  a: AgentWorkspaceFileReadRequest,
  b: AgentWorkspaceFileReadRequest,
) {
  return (
    a.protocolMajor === b.protocolMajor &&
    a.requestId === b.requestId &&
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId &&
    a.path === b.path
  );
}

/** Same ownership rule as `findOwnedSkillsAssignment`: the agent must belong to the viewer's
 * workspace, be owned by the viewer, and have an online-eligible Computer relationship. Workspace
 * Files has no use for `provider`, so this returns the narrower shape directly rather than going
 * through Skills' runtime-config parsing. */
export async function findOwnedWorkspaceFilesAssignment(
  db: PrismaClient,
  viewer: WorkspaceFilesViewer,
  id: string,
): Promise<WorkspaceFilesAssignment | undefined> {
  const agent = await db.agent.findFirst({
    where: {
      id,
      workspaceId: viewer.workspaceId,
      ownerId: viewer.userId,
      workspace: { members: { some: { userId: viewer.userId } } },
      computer: { workspaces: { some: { workspaceId: viewer.workspaceId } } },
      // Same live-view rule as `findOwnedSkillsAssignment`.
      ...ACTIVE_AGENT_WHERE,
    },
    select: { computerId: true, runtimeConfig: true },
  });
  if (!agent?.computerId) return undefined;
  return {
    computerId: agent.computerId,
    revision: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(agent.runtimeConfig))
      .digest("hex"),
  };
}
