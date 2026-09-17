import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlStore,
} from "../src/server/agents/agent-control.server";
import { AgentSessionReceiver } from "../src/server/agents/agent-session.server";

/** ADR 0042 research: this repository's small, self-contained fixture for `authorizeLaunch`
 * — deliberately not shared with the 2400+ line `agent-control.test.ts` (see the working rules
 * for this branch). Builds a managed Agent whose last operation completed a Start chain, the
 * same shape `AgentControl.start()` leaves behind after a successful managed Start. */
function completedManagedAgent(overrides: Partial<AgentControlAgent["state"]> = {}) {
  const runtimeConfig = {
    runtime: "pi" as const,
    provider: { kind: "default" as const },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  const agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    stoppedAt: null,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 1,
      action: "start",
      phase: "completed",
      configRevision: agentControlRevision(runtimeConfig),
      controlSequence: 1,
      sessionSequence: 0,
      launchId: "launch-a",
      ...overrides,
    },
  };
  return agent;
}

function controlFor(agent: AgentControlAgent) {
  const store: AgentControlStore = {
    get: async () => structuredClone(agent),
    memberRole: async () => "owner",
    replace: async () => {
      throw new Error("authorizeLaunch must never write");
    },
  };
  return new AgentControl(store, { publish: async () => {} }, { run: async (_id, work) => work() });
}

test("authorizeLaunch refuses a self-initiated launch for a managed Agent whose last operation completed (ADR 0042 research, pre-fix)", async () => {
  // This is exactly what the daemon sends for today's self-initiated wake (packages/daemon/src/
  // daemon-runtime/runtime.ts #requestLaunchConfig, `control` undefined => no controlEpoch/
  // requestId/launchId at all) against an Agent that has already completed a managed Start —
  // i.e. every Agent that has ever been started under AgentControl. Proves docs/adr/0042
  // research question 3: this is REFUSED today, not accepted.
  const agent = completedManagedAgent();
  await expect(
    controlFor(agent).authorizeLaunch({ agentId: "a", workspaceId: "w", computerId: "c" }),
  ).rejects.toThrow("Stale Agent launch");
});

/** The launch-config request a daemon-initiated wake sends after ADR 0042: the remembered
 * requestId/controlEpoch/launchId, exactly matching the state `completedManagedAgent()` builds. */
const reusedWakeInput = {
  agentId: "a",
  workspaceId: "w",
  computerId: "c",
  requestId: "start-1",
  controlEpoch: 1,
  launchId: "launch-a",
};

test("authorizeLaunch accepts a wake that reuses the exact scope its last completed operation ran under, without writing", async () => {
  await expect(
    controlFor(completedManagedAgent()).authorizeLaunch(reusedWakeInput),
  ).resolves.toBeUndefined();
});

test("authorizeLaunch refuses a wake whose scope was superseded by a different requestId/epoch", async () => {
  const agent = completedManagedAgent({ requestId: "start-2", epoch: 2, launchId: "launch-b" });
  await expect(controlFor(agent).authorizeLaunch(reusedWakeInput)).rejects.toThrow(
    "Stale Agent launch",
  );
});

test("authorizeLaunch refuses a wake against a failed operation", async () => {
  const agent = completedManagedAgent({ phase: "failed" });
  await expect(controlFor(agent).authorizeLaunch(reusedWakeInput)).rejects.toThrow(
    "Stale Agent launch",
  );
});

test("authorizeLaunch refuses a wake against a stopped operation", async () => {
  const agent = completedManagedAgent({ phase: "stopped" });
  await expect(controlFor(agent).authorizeLaunch(reusedWakeInput)).rejects.toThrow(
    "Stale Agent launch",
  );
});

test("authorizeLaunch refuses a wake for a user-stopped Agent even under its exact last scope (ADR 0038)", async () => {
  const agent = completedManagedAgent();
  agent.stoppedAt = new Date("2026-09-17T00:00:00Z");
  await expect(controlFor(agent).authorizeLaunch(reusedWakeInput)).rejects.toThrow(
    "Stale Agent launch",
  );
});

test("a session report after a wake is accepted by AgentSessionReceiver.authorize by exact launchId match", async () => {
  // agent-session.server.ts's authorize() already accepts phase "completed" (unchanged by this
  // branch) as long as launchId matches exactly -- no server-side change was needed here (ADR
  // 0042 research question 4). This proves the reused-launchId wake's own session report clears
  // it without any code change to AgentSessionReceiver.
  const agent = completedManagedAgent();
  const store: AgentControlStore = {
    get: async () => structuredClone(agent),
    memberRole: async () => "owner",
    replace: async () => true,
  };
  const receiver = new AgentSessionReceiver(store, async () => "daemon-1");
  await expect(
    receiver.authorize(
      { workspaceId: "w", computerId: "c" },
      {
        protocolMajor: 1,
        agentId: "a",
        workspaceId: "w",
        computerId: "c",
        provider: "pi",
        startRequestId: "start-1",
        controlEpoch: 1,
        launchId: "launch-a",
        sessionId: "native-session",
        daemonInstanceId: "daemon-1",
      },
    ),
  ).resolves.toBeUndefined();
});

test("authorizeLaunch's starting-phase branch is unchanged by the new wake branch", async () => {
  const agent = completedManagedAgent({ phase: "starting" });
  await expect(
    controlFor(agent).authorizeLaunch({
      agentId: "a",
      workspaceId: "w",
      computerId: "c",
      requestId: "start-1",
      controlEpoch: 1,
      launchId: "launch-a",
    }),
  ).resolves.toBeUndefined();
});
