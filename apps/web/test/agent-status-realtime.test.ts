import "./dom-setup";
import { expect, jest, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";

class FakeClient {
  handlers = new Map<string, (...args: never[]) => void>();
  on(name: string, handler: (...args: never[]) => void) {
    this.handlers.set(name, handler);
  }
  off(name: string, handler: (...args: never[]) => void) {
    if (this.handlers.get(name) === handler) this.handlers.delete(name);
  }
  emit(name: string, event: unknown) {
    const handler = this.handlers.get(name);
    if (handler) Reflect.apply(handler, undefined, [event]);
  }
}
const realtimeClient = new FakeClient();
mock.module("../src/features/realtime/browser-realtime", () => ({
  useBrowserRealtime: () => realtimeClient,
}));

const {
  applyAgentDisplaySnapshot,
  applyAgentStatusEvent,
  decodeAgentStatusEvent,
  expireAgentStatuses,
  mergeAgentStatusSnapshot,
  useAgentStatuses,
} = await import("../src/features/agents/agent-status-realtime");
import type {
  AgentStatusEvent,
  AgentStatusView,
} from "../src/features/agents/agent-status-realtime";
import {
  parseAgentDisplaySnapshot,
  type AgentDisplaySnapshot,
} from "@coforge/protocol/agent-display";

const ordering = {
  daemonInstanceId: "daemon-1",
  clientSeq: 2,
  observedAtMs: 2_000,
};
const agents: Array<{ id: string; name: string; status: AgentStatusView }> = [
  {
    id: "agent-1",
    name: "Current",
    status: { value: "active" as const, expiresAt: 90_000, ordering },
  },
];

function event(overrides: Partial<AgentStatusEvent> = {}): AgentStatusEvent {
  return {
    agentId: "agent-1",
    status: "active",
    expiresAt: 100_000,
    daemonInstanceId: "daemon-1",
    clientSeq: 2,
    observedAtMs: 2_000,
    ...overrides,
  };
}

function display(overrides: Partial<AgentDisplaySnapshot> = {}): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    revision: 2,
    activityKind: "working",
    detailKind: "running_command",
    detail: "Running command",
    entries: [{ kind: "tool_start", toolName: "shell" }],
    expiresAt: 50_000,
    ...overrides,
  };
}

test("uses ordering metadata for publications and idempotent lease refreshes", () => {
  expect(applyAgentStatusEvent(agents, event({ clientSeq: 1 }))).toEqual(agents);
  expect(applyAgentStatusEvent(agents, event({ status: "inactive", expiresAt: null }))).toEqual(
    agents,
  );
  expect(applyAgentStatusEvent(agents, event())[0]?.status.expiresAt).toBe(100_000);
  expect(applyAgentStatusEvent(agents, event({ expiresAt: 80_000 }))[0]?.status.expiresAt).toBe(
    90_000,
  );
  expect(
    applyAgentStatusEvent(agents, event({ clientSeq: 3 }))[0]?.status.ordering?.clientSeq,
  ).toBe(3);
  expect(
    applyAgentStatusEvent(agents, event({ daemonInstanceId: "daemon-2", observedAtMs: 1_999 })),
  ).toEqual(agents);
  expect(
    applyAgentStatusEvent(agents, event({ daemonInstanceId: "daemon-2", observedAtMs: 2_001 }))[0]
      ?.status.ordering?.daemonInstanceId,
  ).toBe("daemon-2");
  const replacement = applyAgentStatusEvent(
    agents,
    event({ daemonInstanceId: "daemon-2", observedAtMs: 2_001 }),
  );
  expect(
    applyAgentStatusEvent(
      replacement,
      event({ status: "inactive", expiresAt: null, clientSeq: 3 }),
    ),
  ).toEqual(replacement);
});

test("snapshot merges membership and fields without letting unordered status replace ordered status", () => {
  expect(
    mergeAgentStatusSnapshot(agents, [
      {
        id: "agent-1",
        name: "Renamed",
        status: { value: "inactive" as const, expiresAt: null },
      },
      {
        id: "agent-2",
        name: "Added",
        status: { value: "inactive" as const, expiresAt: null },
      },
    ]),
  ).toEqual([
    { ...agents[0], name: "Renamed" },
    {
      id: "agent-2",
      name: "Added",
      status: { value: "inactive", expiresAt: null },
    },
  ]);
});

test("expires an active Agent locally when its lease renewal stops", () => {
  expect(expireAgentStatuses(agents, 90_001)[0]?.status).toEqual({
    value: "inactive",
    expiresAt: null,
    ordering,
  });
});

test("rejects malformed realtime status publications", () => {
  expect(decodeAgentStatusEvent(new TextEncoder().encode(JSON.stringify(event())))).toEqual(
    event(),
  );
  expect(() => decodeAgentStatusEvent(new TextEncoder().encode('{"status":"online"}'))).toThrow();
});

test("parses object and binary display snapshots and rejects invalid public values", () => {
  expect(parseAgentDisplaySnapshot({ type: "agent:display", ...display() })).toEqual(display());
  expect(parseAgentDisplaySnapshot(new TextEncoder().encode(JSON.stringify(display())))).toEqual(
    display(),
  );
  for (const invalid of [
    display({ protocolMajor: 2 as 1 }),
    display({ revision: 0 }),
    display({ workspaceId: "" }),
    display({ activityKind: "busy" as "working" }),
    display({ detail: "x".repeat(513) }),
    display({ expiresAt: Number.POSITIVE_INFINITY }),
    display({ activityKind: "offline", expiresAt: 1 }),
    display({ activityKind: "online", expiresAt: null }),
    display({ entries: [{ kind: "tool_start", toolName: "" }] }),
  ]) {
    expect(() => parseAgentDisplaySnapshot(invalid)).toThrow();
  }
});

test("applies increasing display revisions only within the authorized Agent scope", () => {
  const tracked = agents.map((agent) => ({
    ...agent,
    computerId: "computer-1",
    display: display(),
  }));
  expect(applyAgentDisplaySnapshot(tracked, display({ revision: 1 }), "workspace-1")).toEqual(
    tracked,
  );
  expect(
    applyAgentDisplaySnapshot(
      tracked,
      display({ revision: 3, activityKind: "online" }),
      "workspace-1",
    )[0]?.display?.activityKind,
  ).toBe("online");
  expect(
    applyAgentDisplaySnapshot(
      tracked,
      display({ revision: 3, workspaceId: "workspace-2" }),
      "workspace-1",
    ),
  ).toEqual(tracked);
  expect(
    applyAgentDisplaySnapshot(
      tracked,
      display({ revision: 3, computerId: "computer-2" }),
      "workspace-1",
    ),
  ).toEqual(tracked);
});

test("process publications and list snapshots preserve a newer live display", () => {
  const live = applyAgentDisplaySnapshot(
    agents.map((agent) => ({ ...agent, computerId: "computer-1", display: display() })),
    display({ revision: 3, activityKind: "thinking" }),
    "workspace-1",
  );
  expect(applyAgentStatusEvent(live, event({ clientSeq: 3 }))[0]?.display?.activityKind).toBe(
    "thinking",
  );
  const staleList = live.map((agent) => ({ ...agent, display: display({ revision: 2 }) }));
  expect(mergeAgentStatusSnapshot(live, staleList)[0]?.display?.revision).toBe(3);
});

test("an expired display high-water cannot be revived by an equal or lower revision", () => {
  const expired = agents.map((agent) => ({
    ...agent,
    computerId: "computer-1",
    display: undefined as AgentDisplaySnapshot | undefined,
    displayRevisionHighWater: 4,
  }));
  expect(applyAgentDisplaySnapshot(expired, display({ revision: 4 }), "workspace-1")).toEqual(
    expired,
  );
  expect(applyAgentDisplaySnapshot(expired, display({ revision: 3 }), "workspace-1")).toEqual(
    expired,
  );
  expect(
    applyAgentDisplaySnapshot(
      expired,
      display({ revision: 5, activityKind: "offline", expiresAt: null }),
      "workspace-1",
    )[0]?.display?.activityKind,
  ).toBe("offline");
});

test("display expiry asks the backend to reduce current state without inferring a replacement", async () => {
  jest.useFakeTimers();
  const expiring = agents.map((agent) => ({
    ...agent,
    computerId: "computer-1",
    // Exercise the slow-render case explicitly: expiry precedes effect setup.
    display: display({ expiresAt: Date.now() }),
  }));
  const retryResult = Promise.withResolvers<typeof expiring>();
  const refresh = mock<() => Promise<typeof expiring>>()
    .mockRejectedValueOnce(new Error("temporarily unavailable"))
    .mockImplementation(() => retryResult.promise);
  const { result, unmount } = renderHook(() =>
    useAgentStatuses({ agents: expiring, workspaceId: "workspace-1", refresh }),
  );

  try {
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersToNextTimer();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current[0]?.display?.activityKind).toBe("working");
    await act(async () => {
      jest.advanceTimersToNextTimer();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result.current[0]?.display?.activityKind).toBe("working");
    await act(async () => {
      retryResult.resolve(
        expiring.map((agent) => ({
          ...agent,
          display: display({ revision: 3, activityKind: "online", expiresAt: null }),
        })),
      );
      await retryResult.promise;
    });
    expect(result.current[0]?.display?.activityKind).toBe("online");
  } finally {
    retryResult.resolve(expiring);
    try {
      unmount();
      jest.runOnlyPendingTimers();
    } finally {
      jest.useRealTimers();
    }
  }
});

test("an expired display is retained while a successful incomplete refresh retries at the failure pace", async () => {
  const expiring: Array<
    (typeof agents)[number] & { computerId: string; display?: AgentDisplaySnapshot }
  > = agents.map((agent) => ({
    ...agent,
    computerId: "computer-1",
    display: display({ expiresAt: Date.now() + 20 }),
  }));
  const attemptedAt: number[] = [];
  const refresh = mock(async (): Promise<typeof expiring> => {
    attemptedAt.push(Date.now());
    if (attemptedAt.length === 1) {
      return expiring.map((agent) => ({ ...agent, display: undefined }));
    }
    return expiring.map((agent) => ({
      ...agent,
      display: display({ revision: 3, activityKind: "thinking", expiresAt: null }),
    }));
  });
  const { result, unmount } = renderHook(() =>
    useAgentStatuses({ agents: expiring, workspaceId: "workspace-1", refresh }),
  );

  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(result.current[0]?.display?.activityKind).toBe("working");
  await new Promise((resolve) => window.setTimeout(resolve, 100));
  expect(refresh).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2), { timeout: 2_000 });
  expect(attemptedAt[1]! - attemptedAt[0]!).toBeGreaterThanOrEqual(900);
  await waitFor(() => expect(result.current[0]?.display?.activityKind).toBe("thinking"));
  unmount();
});

test("workspace switch ignores an old expiry refresh and accepts the new Workspace snapshot", async () => {
  const oldAgents = agents.map((agent) => ({
    ...agent,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    display: display({ expiresAt: Date.now() + 20 }),
  }));
  let resolveOld!: (value: typeof oldAgents) => void;
  const newAgents = agents.map((agent) => ({
    ...agent,
    workspaceId: "workspace-2",
    computerId: "computer-2",
    display: display({
      workspaceId: "workspace-2",
      computerId: "computer-2",
      activityKind: "online",
      expiresAt: null,
    }),
  }));
  const oldRefresh = () =>
    new Promise<typeof oldAgents>((resolve) => {
      resolveOld = resolve;
    });
  const newRefresh = async () => newAgents;
  const { result, rerender, unmount } = renderHook(
    ({ currentAgents, workspaceId, refresh }) =>
      useAgentStatuses({ agents: currentAgents, workspaceId, refresh }),
    {
      initialProps: {
        currentAgents: oldAgents,
        workspaceId: "workspace-1",
        refresh: oldRefresh,
      },
    },
  );
  await waitFor(() => expect(resolveOld).toBeFunction());
  rerender({ currentAgents: newAgents, workspaceId: "workspace-2", refresh: newRefresh });
  await act(async () => resolveOld(oldAgents));
  expect(result.current[0]?.workspaceId).toBe("workspace-2");
  expect(result.current[0]?.display?.activityKind).toBe("online");
  unmount();
});

test("StrictMode remount keeps expiry refresh results enabled", async () => {
  const current = agents.map((agent) => ({
    ...agent,
    computerId: "computer-1",
    display: display({ expiresAt: Date.now() + 20 }),
  }));
  const refresh = async () =>
    current.map((agent) => ({
      ...agent,
      display: display({ revision: 3, activityKind: "thinking", expiresAt: null }),
    }));
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(StrictMode, null, children);
  const { result, unmount } = renderHook(
    () => useAgentStatuses({ agents: current, workspaceId: "workspace-1", refresh }),
    { wrapper },
  );
  await waitFor(() => expect(result.current[0]?.display?.activityKind).toBe("thinking"));
  unmount();
});

test("a reconnect retries snapshot hydration after the previous reconnect failed", async () => {
  const current = agents.map((agent) => ({
    ...agent,
    computerId: "computer-1",
    display: display({ activityKind: "online", expiresAt: null }),
  }));
  let attempts = 0;
  const refresh = mock(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporarily unavailable");
    return current.map((agent) => ({
      ...agent,
      display: display({ revision: 3, activityKind: "thinking", expiresAt: null }),
    }));
  });
  const { result, unmount } = renderHook(() =>
    useAgentStatuses({ agents: current, workspaceId: "workspace-1", refresh }),
  );
  act(() => realtimeClient.emit("connected", {}));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(result.current[0]?.display?.activityKind).toBe("online");
  act(() => realtimeClient.emit("connected", {}));
  await waitFor(() => expect(result.current[0]?.display?.activityKind).toBe("thinking"));
  unmount();
});
