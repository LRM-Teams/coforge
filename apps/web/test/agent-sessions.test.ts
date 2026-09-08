import { expect, test } from "bun:test";
import { encodeAgentSessionReport } from "@coforge/protocol";
import { createAgentSessionMethod } from "../src/server/centrifugo/rpc-handler.server";
import {
  AgentSessions,
  type RuntimeSessionReference,
} from "../src/server/agents/agent-sessions.server";

test("cloud selection survives recreation and stale launches cannot replace a session", async () => {
  let reference: RuntimeSessionReference | null = null;
  const repository = {
    async read() {
      return { workspaceId: "w", computerId: "c", provider: "codex", reference };
    },
    async replace(
      _id: string,
      previous: RuntimeSessionReference | null,
      next: RuntimeSessionReference,
    ) {
      if (reference !== previous) return false;
      reference = next;
      return true;
    },
  };
  const current = async () => "daemon-new";
  const sessions = new AgentSessions(repository, current);
  const intent = {
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex" as const,
    model: "m",
    reasoning: "r",
  };
  expect((await sessions.prepare(intent)).sessionId).toBeUndefined();
  const report = {
    ...intent,
    requestId: "report",
    startRequestId: "start-1",
    sessionId: "thread-1",
    daemonInstanceId: "daemon-new",
    launchId: "launch-1",
  };
  const method = createAgentSessionMethod(sessions);
  await expect(
    method(encodeAgentSessionReport(report), {
      principal: { userId: "u", workspaceId: "w", computerId: "c", agentId: "other-agent" },
    }),
  ).resolves.toMatchObject({ code: 403 });
  expect(
    await method(encodeAgentSessionReport(report), {
      principal: { userId: "u", workspaceId: "other-workspace", computerId: "c" },
    }),
  ).toMatchObject({ code: 403 });
  expect(
    await method(encodeAgentSessionReport(report), {
      principal: { userId: "u", workspaceId: "w", computerId: "c" },
    }),
  ).toBeInstanceOf(Uint8Array);
  await sessions.accept(report);
  const recovered = new AgentSessions(repository, current);
  const repeated = await recovered.prepare({ ...intent, requestId: "start-2" });
  expect(repeated.sessionId).toBe("thread-1");
  expect(repeated.requestId).toBe("start-1");
  expect(repeated.previousLaunchId).toBe("launch-1");
  await sessions.accept(report);
  const successor = { ...report, launchId: "launch-2", previousLaunchId: "launch-1" };
  await sessions.accept(successor);
  await sessions.accept(successor);
  await expect(sessions.accept(report)).rejects.toThrow();
  await expect(sessions.accept({ ...successor, launchId: "fork" })).rejects.toThrow();
  await expect(sessions.accept({ ...report, sessionId: "stale" })).rejects.toThrow();
  await expect(
    sessions.accept({ ...report, startRequestId: "start-2", daemonInstanceId: "old" }),
  ).rejects.toThrow();
  expect((await repository.read()).reference?.sessionId).toBe("thread-1");
  await sessions.retire("a", "w", "c");
  await expect(sessions.accept({ ...report, startRequestId: "start-2" })).rejects.toThrow();
  expect((await recovered.prepare({ ...intent, requestId: "start-3" })).sessionId).toBe("thread-1");
  await expect(
    sessions.accept({ ...report, startRequestId: "start-3", computerId: "other" }),
  ).rejects.toThrow();
  await expect(
    sessions.accept({ ...report, startRequestId: "start-3", provider: "pi" }),
  ).rejects.toThrow();
  await expect(
    recovered.prepare({ ...intent, requestId: "fresh", sessionId: "explicit-selection" }),
  ).rejects.toThrow("Stop");
  await recovered.retire("a", "w", "c");
  const fresh = await recovered.prepare({
    ...intent,
    requestId: "fresh",
    sessionId: "explicit-selection",
  });
  expect(fresh.sessionId).toBe("explicit-selection");
  await expect(sessions.accept({ ...report, startRequestId: "fresh" })).rejects.toThrow();
  const fallback = {
    ...report,
    startRequestId: "fresh",
    sessionId: "new-after-missing",
    replacedSessionId: "explicit-selection",
  };
  await expect(
    sessions.accept({ ...fallback, replacedSessionId: "wrong-old-id" }),
  ).rejects.toThrow();
  await sessions.accept(fallback);
  await sessions.accept(fallback);
  expect((await new AgentSessions(repository, current).prepare(intent)).sessionId).toBe(
    "new-after-missing",
  );
  await expect(sessions.accept({ ...fallback, sessionId: "another-new" })).rejects.toThrow();
  await expect(
    sessions.accept({ ...report, startRequestId: "fresh", sessionId: "explicit-selection" }),
  ).rejects.toThrow();
});

test("cloud creates a fresh CoForge identity instead of reviving historical defaults after provider change", async () => {
  let reference: RuntimeSessionReference | null = null;
  let daemon = "daemon";
  const sessions = new AgentSessions(
    {
      async read() {
        return { workspaceId: "w", computerId: "c", provider: "coforge", reference };
      },
      async replace(_id, _previous, next) {
        reference = next;
        return true;
      },
    },
    async () => daemon,
  );
  const intent = {
    protocolMajor: 1,
    requestId: "start",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "coforge" as const,
    model: "m",
    reasoning: "r",
  };
  const selected = await sessions.prepare(intent);
  expect(selected.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(selected.sessionMode).toBe("create");
  expect((await sessions.prepare(intent)).sessionId).toBe(selected.sessionId);
  daemon = "replacement-before-ack";
  expect(await sessions.prepare(intent)).toMatchObject({
    sessionId: selected.sessionId,
    sessionMode: "create",
  });
  await sessions.accept({
    ...intent,
    sessionId: selected.sessionId!,
    startRequestId: "start",
    daemonInstanceId: daemon,
    launchId: "launch",
  });
  daemon = "replacement-after-ack";
  expect((await sessions.prepare(intent)).sessionMode).toBe("resume");
  await sessions.retire("a", "w", "c");
  expect((await sessions.prepare({ ...intent, sessionId: "explicit-fresh" })).sessionId).toBe(
    "explicit-fresh",
  );
});

test("stop never relabels another Computer's provider session as locally resumable", async () => {
  let reference: RuntimeSessionReference | null = {
    provider: "codex",
    computerId: "computer-a",
    sessionId: "computer-a-thread",
    startRequestId: "old-start",
    daemonInstanceId: "old-daemon",
    launchId: "old-launch",
  };
  const sessions = new AgentSessions(
    {
      async read() {
        return { workspaceId: "w", computerId: "computer-b", provider: "codex", reference };
      },
      async replace(_id, previous, next) {
        if (reference !== previous) return false;
        reference = next;
        return true;
      },
    },
    async () => "computer-b-daemon",
  );
  await sessions.retire("a", "w", "computer-b");
  const selected = await sessions.prepare({
    protocolMajor: 1,
    requestId: "new-start",
    workspaceId: "w",
    computerId: "computer-b",
    agentId: "a",
    provider: "codex",
    model: "m",
    reasoning: "r",
  });
  expect(selected.sessionId).toBeUndefined();
});

test.each(["coforge", "pi", "codex", "claude-code"] as const)(
  "a delayed duplicate %s Start preserves an acknowledged empty launch",
  async (provider) => {
    let reference: RuntimeSessionReference | null = null;
    const sessions = new AgentSessions(
      {
        read: async () => ({ workspaceId: "w", computerId: "c", provider, reference }),
        replace: async (_id, before, next) => {
          if (reference !== before) return false;
          reference = next;
          return true;
        },
      },
      async () => "daemon",
    );
    const intent = {
      protocolMajor: 1,
      requestId: "start",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider,
      model: "",
      reasoning: "",
      controlEpoch: 1,
    };
    const selected = await sessions.prepare(intent);
    const sessionId = selected.sessionId ?? "provider-selected";
    await sessions.accept({
      ...intent,
      requestId: "report",
      startRequestId: "start",
      daemonInstanceId: "daemon",
      launchId: "launch",
      sessionId,
      sessionState: "empty",
    });
    expect(await sessions.prepare(intent)).toMatchObject({
      requestId: "start",
      previousLaunchId: "launch",
      sessionId,
      sessionMode: "resume",
    });
  },
);

test.each(["prepare", "retire"] as const)(
  "a delayed old report cannot overwrite newer %s",
  async (operation) => {
    const fixture = sessionRace();
    const gate = fixture.pauseNextReplace();
    const report = fixture.sessions.accept(fixture.report);
    await gate.entered.promise;
    fixture.setDaemon("new-daemon");
    try {
      if (operation === "prepare") await fixture.sessions.prepare(fixture.intent);
      else await fixture.sessions.retire("a", "w", "c");
    } finally {
      gate.release.resolve();
    }
    await expect(report).rejects.toThrow("changed concurrently");
    expect(fixture.reference()?.sessionId).toBeUndefined();
    expect(fixture.reference()?.daemonInstanceId).toBe(operation === "prepare" ? "new-daemon" : "");
  },
);

test.each(["prepare", "retire"] as const)(
  "report winning before %s remains selected history, not an atomic Redis fence",
  async (operation) => {
    const fixture = sessionRace();
    const gate = fixture.pauseNextReplace();
    const report = fixture.sessions.accept(fixture.report);
    await gate.entered.promise;
    fixture.setDaemon("new-daemon");
    gate.release.resolve();
    // The SQL CAS can still win after Redis changed, before a newer SQL selection.
    await report;
    if (operation === "retire") await fixture.sessions.retire("a", "w", "c");
    expect((await fixture.sessions.prepare(fixture.intent)).sessionId).toBe("old-session");
    expect(fixture.reference()?.daemonInstanceId).toBe("new-daemon");
  },
);

function sessionRace() {
  let reference: RuntimeSessionReference | null = {
    provider: "codex",
    computerId: "c",
    startRequestId: "old-start",
    daemonInstanceId: "old-daemon",
  };
  let daemon = "old-daemon";
  let pause:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const sessions = new AgentSessions(
    {
      async read() {
        return {
          workspaceId: "w",
          computerId: "c",
          provider: "codex",
          reference: structuredClone(reference),
        };
      },
      async replace(_agentId, previous, next) {
        const gate = pause;
        pause = undefined;
        if (gate) {
          gate.entered.resolve();
          await gate.release.promise;
        }
        if (JSON.stringify(reference) !== JSON.stringify(previous)) return false;
        reference = JSON.parse(JSON.stringify(next));
        return true;
      },
    },
    async () => daemon,
  );
  const intent = {
    protocolMajor: 1,
    requestId: "new-start",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex" as const,
    model: "m",
    reasoning: "r",
  };
  return {
    sessions,
    intent,
    report: {
      ...intent,
      requestId: "report",
      startRequestId: "old-start",
      sessionId: "old-session",
      daemonInstanceId: "old-daemon",
      launchId: "old-launch",
    },
    reference: () => structuredClone(reference),
    setDaemon(value: string) {
      daemon = value;
    },
    pauseNextReplace() {
      pause = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      return pause;
    },
  };
}
