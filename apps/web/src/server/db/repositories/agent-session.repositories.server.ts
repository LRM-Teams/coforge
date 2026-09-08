import { Prisma, type PrismaClient } from "../../../../generated/client";
import { z } from "zod";
import {
  AgentSessions,
  type AgentSessionRepository,
  type RuntimeSessionReference,
} from "../../agents/agent-sessions.server";
import { parseAgentRuntimeConfig } from "../../agents/agent-runtime-config.server";
import { getComputerRestartStore } from "../../computers/computer-restart-store.server";

const referenceSchema = z.object({
  provider: z.string(),
  computerId: z.string(),
  sessionId: z.string().optional(),
  sessionMode: z.enum(["create", "resume"]).optional(),
  startRequestId: z.string(),
  daemonInstanceId: z.string(),
  launchId: z.string().optional(),
});

export class PrismaAgentSessionRepository implements AgentSessionRepository {
  constructor(private readonly db: PrismaClient) {}
  async read(agentId: string) {
    const agent = await this.db.agent.findUnique({ where: { id: agentId } });
    if (!agent) return undefined;
    return {
      workspaceId: agent.workspaceId,
      computerId: agent.computerId ?? undefined,
      provider: parseAgentRuntimeConfig(agent.runtimeConfig).runtime,
      reference: agent.runtimeSession === null ? null : referenceSchema.parse(agent.runtimeSession),
    };
  }
  async replace(
    agentId: string,
    previous: RuntimeSessionReference | null,
    next: RuntimeSessionReference,
  ) {
    const result = await this.db.agent.updateMany({
      where: {
        id: agentId,
        computerId: next.computerId,
        runtimeConfig: { path: ["runtime"], equals: next.provider },
        runtimeSession: { equals: previous ?? Prisma.DbNull },
      },
      data: { runtimeSession: next },
    });
    return result.count === 1;
  }
}

export function createAgentSessions(db: PrismaClient) {
  return new AgentSessions(
    new PrismaAgentSessionRepository(db),
    async (workspaceId, computerId) =>
      (await getComputerRestartStore().identity?.({ workspaceId, computerId }))?.workerInstanceId,
  );
}
