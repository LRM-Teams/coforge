import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlStore,
} from "../src/server/agents/agent-control.server";

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
