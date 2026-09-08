import { Prisma, type PrismaClient } from "../../../../generated/client";
import { z } from "zod";
import {
  AgentSessions,
  type AgentSessionRepository,
  type AgentSessionWriteScope,
  type RuntimeSessionReference,
} from "../../agents/agent-sessions.server";
import { parseAgentRuntimeConfig } from "../../agents/agent-runtime-config.server";
import { getComputerRestartStore } from "../../computers/computer-restart-store.server";

const referenceSchema = z.object({
  provider: z.string(),
  computerId: z.string(),
  sessionMode: z.enum(["create", "resume"]).optional(),
  startRequestId: z.string(),
  daemonInstanceId: z.string(),
  launchId: z.string().optional(),
});
const sessionStateSchema = z.enum(["empty", "unknown", "resumable"]);
const controlScopeSchema = z.object({
  requestId: z.string(),
  epoch: z.number(),
  phase: z.string(),
  launchId: z.string().optional(),
});

function fence(reference: RuntimeSessionReference) {
  const { sessionId: _sessionId, state: _state, ...stored } = reference;
  return referenceSchema.parse(stored);
}

export class PrismaAgentSessionRepository implements AgentSessionRepository {
  constructor(private readonly db: PrismaClient) {}
  async read(agentId: string) {
    const agent = await this.db.agent.findUnique({
      where: { id: agentId },
      include: { currentSession: true },
    });
    if (!agent) return undefined;
    const stored =
      agent.runtimeSession === null ? null : referenceSchema.parse(agent.runtimeSession);
    const session = agent.currentSession;
    if (session && (session.agentId !== agent.id || session.workspaceId !== agent.workspaceId))
      throw new Error("Agent Session association is invalid");
    const scopedSession =
      session && stored?.provider === session.provider && stored.computerId === session.computerId
        ? session
        : undefined;
    return {
      workspaceId: agent.workspaceId,
      computerId: agent.computerId ?? undefined,
      provider: parseAgentRuntimeConfig(agent.runtimeConfig).runtime,
      reference:
        stored === null
          ? null
          : {
              ...stored,
              ...(scopedSession?.nativeSessionId
                ? { sessionId: scopedSession.nativeSessionId }
                : {}),
              ...(scopedSession ? { state: sessionStateSchema.parse(scopedSession.state) } : {}),
            },
    };
  }
  async replace(
    agentId: string,
    previous: RuntimeSessionReference | null,
    next: RuntimeSessionReference,
    scope: AgentSessionWriteScope,
  ) {
    return this.db.$transaction(async (tx) => {
      // Serialize with control/snapshot writers before reading the related row.
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agentId}::uuid FOR UPDATE`;
      const current = await tx.agent.findUnique({
        where: { id: agentId },
        select: {
          workspaceId: true,
          currentSessionId: true,
          currentSession: true,
          controlState: true,
        },
      });
      const control = controlScopeSchema.safeParse(current?.controlState);
      if (
        scope.controlEpoch !== undefined
          ? !control.success ||
            control.data.requestId !== scope.requestId ||
            control.data.epoch !== scope.controlEpoch ||
            !["starting", "completed"].includes(control.data.phase) ||
            (scope.launchId !== undefined && control.data.launchId !== scope.launchId)
          : current?.controlState !== null
      )
        return false;
      const previousSessionId = previous?.sessionId;
      const previousState = previous?.state;
      if (
        !current ||
        (previous !== null &&
          (current.currentSession?.nativeSessionId ?? undefined) !== previousSessionId) ||
        (previous !== null &&
          previousState !== undefined &&
          current.currentSession?.state !== previousState)
      )
        return false;

      const locked = await tx.agent.updateMany({
        where: {
          id: agentId,
          workspaceId: scope.workspaceId,
          computerId: next.computerId,
          currentSessionId: current.currentSessionId ?? null,
          runtimeConfig: { path: ["runtime"], equals: next.provider },
          runtimeSession: { equals: previous ? fence(previous) : Prisma.DbNull },
          controlState: { equals: current.controlState ?? Prisma.DbNull },
          ...(previous
            ? {
                currentSession: {
                  is: {
                    nativeSessionId: previousSessionId ?? null,
                    ...(previousState === undefined ? {} : { state: previousState }),
                  },
                },
              }
            : {}),
        },
        data: { currentSessionId: current.currentSessionId ?? null },
      });
      if (locked.count !== 1) return false;

      let currentSessionId = current.currentSessionId;
      const compatible =
        current.currentSession?.provider === next.provider &&
        current.currentSession.computerId === next.computerId;
      if (
        !compatible ||
        (next.sessionId &&
          current.currentSession?.nativeSessionId &&
          current.currentSession.nativeSessionId !== next.sessionId) ||
        (next.sessionMode === "create" &&
          !next.sessionId &&
          current.currentSession?.nativeSessionId)
      ) {
        currentSessionId = (
          await tx.agentSession.create({
            data: {
              agentId,
              workspaceId: current.workspaceId,
              computerId: next.computerId,
              provider: next.provider,
              nativeSessionId: next.sessionId ?? null,
              state: next.state ?? "unknown",
            },
          })
        ).id;
      } else if (currentSessionId && next.sessionId) {
        await tx.agentSession.update({
          where: { id: currentSessionId },
          data: {
            nativeSessionId: next.sessionId,
            state: next.state ?? current.currentSession?.state ?? "unknown",
          },
        });
      }
      await tx.agent.update({
        where: { id: agentId },
        data: { runtimeSession: fence(next), currentSessionId },
      });
      return true;
    });
  }
}

export function createAgentSessions(db: PrismaClient) {
  return new AgentSessions(
    new PrismaAgentSessionRepository(db),
    async (workspaceId, computerId) =>
      (await getComputerRestartStore().identity?.({ workspaceId, computerId }))?.workerInstanceId,
  );
}
