import type { PrismaClient } from "@/generated/prisma/client";
import { AgentControl } from "@/server/agents/agent-control.server";
import { getAgentControlSignal } from "@/server/agents/agent-control-signal.server";
import { getAgentRuntimeLock } from "@/server/agents/agent-runtime-lock.server";
import { createCentrifugoServerApi } from "@/server/centrifugo/server-api.server";
import { PrismaDirectConversationRepository } from "@/server/db/repositories/direct-conversation.repositories.server";
import { PrismaAgentControlStore } from "@/server/db/repositories/agent-control.repositories.server";
import { createAgentSessions } from "@/server/db/repositories/agent-session.repositories.server";

export type WeeklyReportAssistantLaunchPlan =
  | { action: "deliver" }
  | {
      action: "start" | "stop-then-start";
      sessionId: string;
      sessionMode: "create" | "resume";
    };

/**
 * Whether a WeeklyReportAssistant wake can deliver into the process already
 * running. A user stop or a different native session must not receive the turn.
 */
export function planWeeklyReportAssistantSubjectLaunch(input: {
  mappedSessionId: string;
  mappingCreated: boolean;
  phase: string | null;
  action: string | null;
  runningSessionId: string | null;
  stoppedByUser: boolean;
}): WeeklyReportAssistantLaunchPlan {
  const sessionMode = input.mappingCreated ? "create" : "resume";
  const processLive =
    input.phase === "starting" ||
    input.phase === "stopping" ||
    input.phase === "clearing" ||
    (input.phase === "completed" && input.action !== "stop");
  if (!input.stoppedByUser && processLive && input.runningSessionId === input.mappedSessionId)
    return { action: "deliver" };
  if (processLive)
    return { action: "stop-then-start", sessionId: input.mappedSessionId, sessionMode };
  return { action: "start", sessionId: input.mappedSessionId, sessionMode };
}

export type WeeklyReportAssistantSubjectRuntime = {
  presence(input: { userId: string; workspaceId: string; agentId: string }): Promise<{
    phase: string | null;
    action: string | null;
    sessionId: string | null;
    stoppedByUser: boolean;
  }>;
  stop(input: { userId: string; workspaceId: string; agentId: string }): Promise<void>;
  startOnSession(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    sessionId: string;
    sessionMode: "create" | "resume";
  }): Promise<void>;
};

/** Stop a different subject process before starting the mapped session. */
export async function alignWeeklyReportAssistantSubjectRuntime(
  runtime: WeeklyReportAssistantSubjectRuntime,
  input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    sessionId: string;
    created: boolean;
  },
): Promise<void> {
  const presence = await runtime.presence(input);
  const plan = planWeeklyReportAssistantSubjectLaunch({
    mappedSessionId: input.sessionId,
    mappingCreated: input.created,
    phase: presence.phase,
    action: presence.action,
    runningSessionId: presence.sessionId,
    stoppedByUser: presence.stoppedByUser,
  });
  if (plan.action === "deliver") return;
  if (plan.action === "stop-then-start") await runtime.stop(input);
  await runtime.startOnSession({
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    sessionId: plan.sessionId,
    sessionMode: plan.sessionMode,
  });
}

export function createWeeklyReportAssistantSubjectRuntime(
  db: PrismaClient,
): WeeklyReportAssistantSubjectRuntime {
  const control = new AgentControl(
    new PrismaAgentControlStore(db),
    createCentrifugoServerApi(),
    getAgentRuntimeLock(),
    undefined,
    createAgentSessions(db),
    getAgentControlSignal(),
    new PrismaDirectConversationRepository(db),
  );
  return {
    presence: (input) => control.readLaunchPresence(input),
    stop: (input) =>
      control.publishStop(
        {
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          requestId: crypto.randomUUID(),
        },
        input.userId,
      ),
    startOnSession: (input) => control.startOnSession(input),
  };
}
