import { expect, test } from "bun:test";
import { encodeAgentSessionReport, type AgentSessionReport } from "@coforge/protocol";
import { AgentSessionReceiver } from "../src/server/agents/agent-session.server";
import {
  agentControlRevision,
  type AgentControlAgent,
} from "../src/server/agents/agent-control.server";
import { createAgentSessionMethod } from "../src/server/centrifugo/agent-session-receiver.server";

test("Session RPC preserves control state and rejects stale scope, revoked access and lost writes", async () => {
  const snapshot: AgentSessionReport = {
    protocolMajor: 1,
    requestId: "report",
    startRequestId: "request",
    daemonInstanceId: "daemon",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "pi",
    controlEpoch: 1,
    launchId: "launch",
    sequence: 2,
    sessionId: "native",
    sessionState: "resumable",
  };
  const config = {
    runtime: "pi" as const,
    provider: { kind: "default" as const },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  let agent: AgentControlAgent = {
    id: "agent",
    workspaceId: "workspace",
    computerId: "computer",
    ownerId: "owner",
    runtimeConfig: config,
    state: {
      ...snapshot,
      requestId: "request",
      epoch: 1,
      version: 1,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(config),
      controlSequence: 1,
      sessionSequence: 0,
    },
  };
  let authorized = true;
  let writable = true;
  let writes = 0;
  const method = createAgentSessionMethod(
    {
      accept: async () => {
        throw new Error("Snapshots must use the snapshot receiver");
      },
      verify: async () => ({
        provider: snapshot.provider,
        computerId: snapshot.computerId,
        startRequestId: snapshot.startRequestId,
        daemonInstanceId: snapshot.daemonInstanceId,
      }),
    },
    new AgentSessionReceiver({
      get: async (id) => (authorized && id === agent.id ? structuredClone(agent) : undefined),
      replace: async (_before, state) => {
        if (!writable) return false;
        writes++;
        agent = { ...agent, state };
        return true;
      },
    }),
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };
  const bytes = encodeAgentSessionReport(snapshot);
  expect(await method(bytes, { principal: { ...principal, agentId: "agent" } })).toMatchObject({
    code: 403,
  });
  for (const claim of [
    { ...principal, workspaceId: "other" },
    { ...principal, computerId: "other" },
  ])
    expect(await method(bytes, { principal: claim })).toMatchObject({ code: 403 });
  for (const stale of [
    { ...snapshot, controlEpoch: 2 },
    { ...snapshot, startRequestId: "other" },
    { ...snapshot, launchId: "other" },
    { ...snapshot, agentId: "other" },
    { ...snapshot, provider: "codex" as const },
  ])
    expect(await method(encodeAgentSessionReport(stale), { principal })).toMatchObject({
      code: 403,
    });
  authorized = false;
  expect(await method(bytes, { principal })).toMatchObject({ code: 403 });
  authorized = true;
  agent.runtimeConfig = { ...config, model: "changed" };
  expect(await method(bytes, { principal })).toMatchObject({ code: 403 });
  agent.runtimeConfig = config;
  writable = false;
  expect(await method(bytes, { principal })).toMatchObject({ code: 403 });
  expect(writes).toBe(0);
  writable = true;
  expect(await method(bytes, { principal })).toBeInstanceOf(Uint8Array);
  expect(agent.state).toMatchObject({
    phase: "starting",
    controlSequence: 1,
    sessionSequence: 2,
    identity: { sessionId: "native", state: "resumable" },
  });
  expect(await method(bytes, { principal })).toBeInstanceOf(Uint8Array);
  expect(writes).toBe(1);
});
