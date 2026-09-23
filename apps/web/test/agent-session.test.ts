import { expect, test } from "bun:test";
import {
  encodeAgentSessionReport,
  encodeAgentSessionInvalidate,
  type AgentSessionReport,
  type AgentSessionInvalidate,
} from "@lrm/coforge-sdk/internal";
import { AgentSessionReceiver } from "#src/server/agents/agent-session.server";
import {
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlState,
} from "#src/server/agents/agent-control.server";
import {
  createAgentSessionMethod,
  createAgentSessionInvalidateMethod,
} from "#src/server/centrifugo/agent-session-receiver.server";

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
    visibility: "public",
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
    new AgentSessionReceiver(
      {
        get: async (id) => (authorized && id === agent.id ? structuredClone(agent) : undefined),
        replace: async (_before, state) => {
          if (!writable) return false;
          writes++;
          agent = { ...agent, state };
          return true;
        },
        memberRole: async () => "owner",
      },
      // Not exercised by `.authorize`/`.accept`, only by `.invalidate`.
      async () => "daemon",
    ),
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

function invalidateFixture() {
  const config = {
    runtime: "codex" as const,
    provider: { kind: "default" as const },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  const state: AgentControlState = {
    version: 1,
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex",
    epoch: 1,
    action: "start",
    phase: "starting",
    configRevision: agentControlRevision(config),
    launchId: "launch-1",
    identity: { sessionId: "stale-session", state: "resumable" },
    controlSequence: 0,
    sessionSequence: 1,
  };
  const agent: AgentControlAgent = {
    id: "agent",
    workspaceId: "workspace",
    computerId: "computer",
    ownerId: "owner",
    visibility: "public",
    runtimeConfig: config,
    state,
    identity: state.identity,
  };
  const message: AgentSessionInvalidate = {
    protocolMajor: 1,
    requestId: "invalidate-1",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex",
    sessionId: "stale-session",
    daemonInstanceId: "daemon-current",
    launchId: "launch-1",
    reason: "missing",
  };
  return { agent, message };
}

test("session invalidate clears a matching Session association and leaves every other field unchanged", async () => {
  const { agent, message } = invalidateFixture();
  let stored = agent;
  const calls: Array<{ clearSession?: boolean }> = [];
  const receiver = new AgentSessionReceiver(
    {
      get: async (id) => (id === stored.id ? structuredClone(stored) : undefined),
      memberRole: async () => "owner",
      replace: async (_before, next, options) => {
        calls.push({ clearSession: options?.clearSession });
        stored = { ...stored, state: next, identity: next.identity };
        return true;
      },
    },
    async () => "daemon-current",
  );
  const claim = { workspaceId: "workspace", computerId: "computer" };

  await receiver.invalidate(claim, message);

  expect(calls).toEqual([{ clearSession: true }]);
  expect(stored.state?.identity).toBeUndefined();
  // Raft reports this only through the daemon's own cold-start Activity; the invalidate never
  // marks the state `recovered` (that stays `AgentControl.result`'s and the snapshot path's own
  // signal), and every other field is untouched.
  expect(stored.state?.recovered).toBeUndefined();
  expect(stored.state).toMatchObject({
    phase: agent.state!.phase,
    action: agent.state!.action,
    launchId: agent.state!.launchId,
    controlSequence: agent.state!.controlSequence,
    sessionSequence: agent.state!.sessionSequence,
  });
});

test("session invalidate is a no-op when the Agent has no server control state", async () => {
  const { agent, message } = invalidateFixture();
  let calls = 0;
  const receiver = new AgentSessionReceiver(
    {
      get: async (id) => (id === agent.id ? { ...structuredClone(agent), state: null } : undefined),
      memberRole: async () => "owner",
      replace: async () => {
        calls++;
        return true;
      },
    },
    async () => "daemon-current",
  );

  await receiver.invalidate({ workspaceId: "workspace", computerId: "computer" }, message);

  expect(calls).toBe(0);
});

test("session invalidate silently drops a lost compare-and-swap race instead of throwing", async () => {
  const { agent, message } = invalidateFixture();
  const receiver = new AgentSessionReceiver(
    {
      get: async (id) => (id === agent.id ? structuredClone(agent) : undefined),
      memberRole: async () => "owner",
      // `store.replace` signals a lost CAS by returning false, not by throwing.
      replace: async () => false,
    },
    async () => "daemon-current",
  );

  await expect(
    receiver.invalidate({ workspaceId: "workspace", computerId: "computer" }, message),
  ).resolves.toBeUndefined();
});

test("session invalidate propagates a genuine store failure instead of swallowing it", async () => {
  const { agent, message } = invalidateFixture();
  const receiver = new AgentSessionReceiver(
    {
      get: async (id) => (id === agent.id ? structuredClone(agent) : undefined),
      memberRole: async () => "owner",
      replace: async () => {
        throw new Error("database unavailable");
      },
    },
    async () => "daemon-current",
  );

  await expect(
    receiver.invalidate({ workspaceId: "workspace", computerId: "computer" }, message),
  ).rejects.toThrow("database unavailable");
});

test("session invalidate ignores a non-matching session id, launch id, or scope idempotently", async () => {
  const { agent, message } = invalidateFixture();
  let calls = 0;
  const receiver = new AgentSessionReceiver(
    {
      get: async (id) => (id === agent.id ? structuredClone(agent) : undefined),
      memberRole: async () => "owner",
      replace: async () => {
        calls++;
        return true;
      },
    },
    async () => "daemon-current",
  );
  const claim = { workspaceId: "workspace", computerId: "computer" };

  // Already replaced: the current identity no longer matches the invalidated one.
  await receiver.invalidate(claim, { ...message, sessionId: "some-other-session" });
  // Stale launch: a newer Start has since begun.
  await receiver.invalidate(claim, { ...message, launchId: "an-older-launch" });
  // Foreign Agent, workspace, computer, or provider scope.
  await receiver.invalidate(claim, { ...message, agentId: "missing-agent" });
  await receiver.invalidate(claim, { ...message, workspaceId: "other" });
  await receiver.invalidate(claim, { ...message, computerId: "other" });
  await receiver.invalidate(claim, { ...message, provider: "kiro" });
  // Claim (trusted transport principal) does not match the message's own scope.
  await receiver.invalidate({ workspaceId: "other", computerId: "computer" }, message);

  expect(calls).toBe(0);
});

test("session invalidate from a stale daemon instance is ignored, not rejected", async () => {
  const { agent, message } = invalidateFixture();
  let calls = 0;
  const receiver = new AgentSessionReceiver(
    {
      get: async (id) => (id === agent.id ? structuredClone(agent) : undefined),
      memberRole: async () => "owner",
      replace: async () => {
        calls++;
        return true;
      },
    },
    async () => "a-different-daemon-instance",
  );

  await receiver.invalidate({ workspaceId: "workspace", computerId: "computer" }, message);

  expect(calls).toBe(0);
});

test("session invalidate for an old launch can never clear a newer Session", async () => {
  const { agent, message } = invalidateFixture();
  // A newer Start has already bound a different Session under a newer launch, exactly what
  // would exist by the time a late/stale invalidate for the OLD launch arrives.
  const newer: AgentControlAgent = {
    ...agent,
    state: {
      ...agent.state!,
      launchId: "launch-2",
      identity: { sessionId: "new-session", state: "resumable" },
    },
    identity: { sessionId: "new-session", state: "resumable" },
  };
  let calls = 0;
  const receiver = new AgentSessionReceiver(
    {
      get: async () => structuredClone(newer),
      memberRole: async () => "owner",
      replace: async () => {
        calls++;
        return true;
      },
    },
    async () => "daemon-current",
  );

  await receiver.invalidate({ workspaceId: "workspace", computerId: "computer" }, message);

  expect(calls).toBe(0);
  expect(newer.state?.identity?.sessionId).toBe("new-session");
});

test("the agent:session:invalidate RPC method authorizes the daemon principal and always acknowledges", async () => {
  const { message } = invalidateFixture();
  const invalidations: AgentSessionInvalidate[] = [];
  const method = createAgentSessionInvalidateMethod({
    invalidate: async (_claim, msg) => {
      invalidations.push(msg);
    },
  });
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };
  const bytes = encodeAgentSessionInvalidate(message);

  expect(await method(bytes, { principal: { ...principal, agentId: "agent" } })).toMatchObject({
    code: 403,
  });
  expect(await method(bytes, { principal: { ...principal, workspaceId: "other" } })).toMatchObject({
    code: 403,
  });
  expect(await method(bytes, { principal })).toBeInstanceOf(Uint8Array);
  expect(invalidations).toEqual([message]);
});
