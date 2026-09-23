import { expect, test } from "bun:test";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  type AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
} from "#src/server/agents/agent-control.server";
import { AgentSessions } from "#src/server/agents/agent-sessions.server";
import {
  alignWeeklyReportAssistantSubjectRuntime,
  planWeeklyReportAssistantSubjectLaunch,
  type WeeklyReportAssistantSubjectRuntime,
} from "#src/server/records/weekly-report-assistant-subject-launch.server";

const MAPPED = "11111111-1111-4111-8111-111111111111";

test("planWeeklyReportAssistantSubjectLaunch delivers when the subject session is already running", () => {
  expect(
    planWeeklyReportAssistantSubjectLaunch({
      mappedSessionId: MAPPED,
      mappingCreated: false,
      phase: "completed",
      action: "start",
      runningSessionId: MAPPED,
      stoppedByUser: false,
    }),
  ).toEqual({ action: "deliver" });
  expect(
    planWeeklyReportAssistantSubjectLaunch({
      mappedSessionId: MAPPED,
      mappingCreated: false,
      phase: "starting",
      action: "start",
      runningSessionId: MAPPED,
      stoppedByUser: false,
    }),
  ).toEqual({ action: "deliver" });
});

test("planWeeklyReportAssistantSubjectLaunch stops a different subject before resume", () => {
  expect(
    planWeeklyReportAssistantSubjectLaunch({
      mappedSessionId: MAPPED,
      mappingCreated: false,
      phase: "completed",
      action: "start",
      runningSessionId: "other-session",
      stoppedByUser: false,
    }),
  ).toEqual({ action: "stop-then-start", sessionId: MAPPED, sessionMode: "resume" });
});

test("planWeeklyReportAssistantSubjectLaunch creates a session the first time a subject is reserved", () => {
  expect(
    planWeeklyReportAssistantSubjectLaunch({
      mappedSessionId: MAPPED,
      mappingCreated: true,
      phase: null,
      action: null,
      runningSessionId: null,
      stoppedByUser: false,
    }),
  ).toEqual({ action: "start", sessionId: MAPPED, sessionMode: "create" });
});

test("planWeeklyReportAssistantSubjectLaunch restarts a user-stopped assistant onto the subject session", () => {
  expect(
    planWeeklyReportAssistantSubjectLaunch({
      mappedSessionId: MAPPED,
      mappingCreated: false,
      phase: "completed",
      action: "stop",
      runningSessionId: MAPPED,
      stoppedByUser: true,
    }),
  ).toEqual({ action: "start", sessionId: MAPPED, sessionMode: "resume" });
});

test("alignWeeklyReportAssistantSubjectRuntime stops before starting a different subject", async () => {
  const calls: string[] = [];
  const runtime: WeeklyReportAssistantSubjectRuntime = {
    presence: async () => ({
      phase: "completed",
      action: "start",
      sessionId: "other-session",
      stoppedByUser: false,
    }),
    stop: async () => {
      calls.push("stop");
    },
    startOnSession: async (input) => {
      calls.push(`start:${input.sessionMode}:${input.sessionId}`);
    },
  };
  await alignWeeklyReportAssistantSubjectRuntime(runtime, {
    userId: "user",
    workspaceId: "workspace",
    agentId: "agent",
    sessionId: MAPPED,
    created: false,
  });
  expect(calls).toEqual([`stop`, `start:resume:${MAPPED}`]);
});

test("startOnSession publishes the mapped session instead of the Agent's current session", async () => {
  const runtimeConfig = {
    runtime: "pi" as const,
    provider: { kind: "default" as const },
    model: "model",
    modelProvider: "provider",
    reasoning: "low",
  };
  let agent: AgentControlAgent = {
    id: "agent",
    ownerId: "user",
    visibility: "public",
    workspaceId: "workspace",
    computerId: "computer",
    runtimeConfig,
    identity: { sessionId: "old-session", state: "resumable" },
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "previous",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      provider: "pi",
      epoch: 3,
      action: "start",
      phase: "completed",
      configRevision: agentControlRevision(runtimeConfig),
      controlSequence: 1,
      sessionSequence: 0,
      launchId: "old-launch",
      identity: { sessionId: "old-session", state: "resumable" },
    },
  };
  const starts: AgentStartIntent[] = [];
  let control: AgentControl;
  const sessions = new AgentSessions(
    {
      read: async () => ({
        workspaceId: "workspace",
        computerId: "computer",
        provider: "pi",
        reference: {
          provider: "pi",
          computerId: "computer",
          sessionId: "old-session",
          sessionMode: "resume",
          state: "resumable",
          startRequestId: "previous",
          daemonInstanceId: "daemon-1",
          launchId: "old-launch",
        },
      }),
      replace: async () => true,
    },
    async () => "daemon-1",
  );
  control = new AgentControl(
    {
      memberRole: async () => "owner",
      get: async () => structuredClone(agent),
      replace: async (_before, state, options) => {
        agent = {
          ...agent,
          state,
          ...(options?.stoppedAt !== undefined ? { stoppedAt: options.stoppedAt } : {}),
        };
        return true;
      },
    },
    {
      publish: async (_channel, bytes) => {
        let start: AgentStartIntent | undefined;
        try {
          start = decodeAgentStartIntent(bytes);
        } catch {
          start = undefined;
        }
        if (start?.sessionId || start?.sessionMode) {
          starts.push(start);
          await control.result(
            { workspaceId: start.workspaceId, computerId: start.computerId! },
            {
              protocolMajor: 1,
              requestId: start.requestId,
              workspaceId: start.workspaceId,
              computerId: start.computerId!,
              agentId: start.agentId,
              provider: start.provider,
              epoch: start.controlEpoch!,
              phase: "started",
              sequence: 1,
              launchId: start.launchId!,
              identity: { sessionId: start.sessionId!, state: "empty" },
            },
          );
          return;
        }
        const stop = decodeAgentStopIntent(bytes);
        await control.result(
          { workspaceId: stop.workspaceId, computerId: stop.computerId },
          {
            protocolMajor: 1,
            requestId: stop.requestId,
            workspaceId: stop.workspaceId,
            computerId: stop.computerId,
            agentId: stop.agentId,
            provider: stop.provider ?? "pi",
            epoch: stop.controlEpoch!,
            phase: "stopped",
            sequence: 1,
          },
        );
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 1_000 },
    sessions,
  );
  await alignWeeklyReportAssistantSubjectRuntime(
    {
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
    },
    {
      userId: "user",
      workspaceId: "workspace",
      agentId: "agent",
      sessionId: MAPPED,
      created: true,
    },
  );
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ sessionId: MAPPED, sessionMode: "create" });
  expect(starts[0]!.sessionId).not.toBe("old-session");
});
