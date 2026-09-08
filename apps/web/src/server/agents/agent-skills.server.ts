import type {
  AgentSkillsListRequest,
  AgentSkillsListResult,
  RuntimeProvider,
} from "@coforge/protocol";
import type { PrismaClient } from "../../../generated/client";
import { parseAgentRuntimeConfig } from "./agent-runtime-config.server";

export type SkillsViewer = { userId: string; workspaceId: string };
export type SkillsAssignment = { computerId: string; provider: RuntimeProvider; revision: string };
export type PendingSkills = { request: AgentSkillsListRequest; userId: string; revision: string };
export interface AgentSkillsResults {
  begin(pending: PendingSkills): Promise<void>;
  read(requestId: string): Promise<AgentSkillsListResult | undefined>;
  clear(requestId: string): Promise<void>;
}
type SkillsResponse =
  | { status: "ready"; result: AgentSkillsListResult }
  | { status: "offline" | "timeout" | "unavailable" };

/** Authorizes a fresh directory observation, not Computer inventory or session state. */
export class AgentSkillsQuery {
  constructor(
    private readonly dependencies: {
      findOwned(viewer: SkillsViewer, agentId: string): Promise<SkillsAssignment | undefined>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      publish(request: AgentSkillsListRequest): Promise<void>;
      results: AgentSkillsResults;
    },
    private readonly timing = { now: Date.now, wait: () => Bun.sleep(100), timeoutMs: 5_000 },
  ) {}

  async get(viewer: SkillsViewer, agentId: string): Promise<SkillsResponse> {
    const { findOwned, online, publish, results } = this.dependencies;
    const assignment = await findOwned(viewer, agentId);
    if (!assignment) return { status: "unavailable" };
    const request: AgentSkillsListRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: assignment.computerId,
      provider: assignment.provider,
      agentId,
    };
    try {
      if (!(await online(request))) return { status: "offline" };
      await results.begin({ request, userId: viewer.userId, revision: assignment.revision });
      await publish(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      do {
        const result = await results.read(request.requestId);
        if (result) {
          const current = await findOwned(viewer, agentId);
          if (
            !current ||
            current.computerId !== assignment.computerId ||
            current.provider !== assignment.provider ||
            current.revision !== assignment.revision ||
            !sameSkillsScope(request, result)
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
      await results.clear(request.requestId).catch(() => {});
    }
  }
}

export function sameSkillsScope(a: AgentSkillsListRequest, b: AgentSkillsListRequest) {
  return (
    a.protocolMajor === b.protocolMajor &&
    a.requestId === b.requestId &&
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId &&
    a.provider === b.provider
  );
}

export async function findOwnedSkillsAssignment(
  db: PrismaClient,
  viewer: SkillsViewer,
  id: string,
): Promise<SkillsAssignment | undefined> {
  const agent = await db.agent.findFirst({
    where: {
      id,
      workspaceId: viewer.workspaceId,
      ownerId: viewer.userId,
      workspace: { members: { some: { userId: viewer.userId } } },
      computer: { workspaces: { some: { workspaceId: viewer.workspaceId } } },
    },
    select: { computerId: true, runtimeConfig: true },
  });
  if (!agent?.computerId) return undefined;
  return {
    computerId: agent.computerId,
    provider: parseAgentRuntimeConfig(agent.runtimeConfig).runtime,
    revision: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(agent.runtimeConfig))
      .digest("hex"),
  };
}
