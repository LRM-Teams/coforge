import { expect, test } from "bun:test";

const {
  ACTIVITY_PROBE_TIMEOUT_MS,
  agentStatusChannel,
  agentStatusChannelForAgent,
  applyAgentDisplaySnapshot,
  applyAgentStatusEvent,
  decodeAgentStatusEvent,
  expireAgentStatuses,
  isAgentVisibilityChangedEvent,
  mergeAgentStatusSnapshot,
  mergeExtraAgents,
  nextDisplayRefreshDelayMs,
} = await import("../src/features/agents/agent-status-realtime");
import type {
  AgentStatusEvent,
  AgentStatusView,
} from "../src/features/agents/agent-status-realtime";
import { parseAgentDisplaySnapshot, type AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

test("agentStatusChannelForAgent names the per-Agent re-routing destination", () => {
  expect(agentStatusChannelForAgent("workspace-1", "agent-1")).toBe(
    "agent:status:workspace-1:agent-1",
  );
  expect(agentStatusChannelForAgent("workspace-1", "agent-1")).not.toBe(
    agentStatusChannel("workspace-1"),
  );
});

test("isAgentVisibilityChangedEvent recognizes the id-only visibility-change event", () => {
  expect(
    isAgentVisibilityChangedEvent({ type: "agent:visibility_changed", agentId: "agent-1" }),
  ).toBe(true);
  expect(isAgentVisibilityChangedEvent({ type: "agent:display", agentId: "agent-1" })).toBe(false);
  expect(isAgentVisibilityChangedEvent({ type: "agent:visibility_changed" })).toBe(false);
  expect(isAgentVisibilityChangedEvent(null)).toBe(false);
  expect(isAgentVisibilityChangedEvent("agent:visibility_changed")).toBe(false);
  expect(isAgentVisibilityChangedEvent([])).toBe(false);
});

// Realtime gap: an owner/admin (or a private Agent's creator) can see private Agents
// outside their own primary `agents` list (e.g. another member's private Agent). `mergeExtraAgents`
// keeps those visible without letting a fresh refresh of the primary list silently drop them.
test("mergeExtraAgents appends extras the primary list does not already have", () => {
  const primary: Array<{ id: string; status: AgentStatusView }> = [
    { id: "own-1", status: { value: "active", expiresAt: 1 } },
  ];
  const extras: Array<{ id: string; status: AgentStatusView }> = [
    { id: "extra-1", status: { value: "inactive", expiresAt: null } },
    { id: "extra-2", status: { value: "inactive", expiresAt: null } },
  ];
  expect(mergeExtraAgents(primary, extras)).toEqual([...primary, ...extras]);
});

test("mergeExtraAgents lets the primary list win when the same id appears in both", () => {
  const primary: Array<{ id: string; status: AgentStatusView }> = [
    { id: "shared", status: { value: "active", expiresAt: 1 } },
  ];
  const extras: Array<{ id: string; status: AgentStatusView }> = [
    { id: "shared", status: { value: "inactive", expiresAt: null } },
  ];
  expect(mergeExtraAgents(primary, extras)).toEqual(primary);
});

test("mergeExtraAgents is a no-op with no extras", () => {
  const primary = [{ id: "own-1", status: { value: "active" as const, expiresAt: 1 } }];
  expect(mergeExtraAgents(primary, [])).toEqual(primary);
});

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

// The exact sequence `useAgentStatuses` runs on every refresh/agent:visibility_changed
// cycle for an "extra" (owner/admin-visible-but-not-owned) Agent — `mergeExtraAgents` re-appends
// its bare placeholder, then `mergeAgentStatusSnapshot` must carry its already-live status and
// display forward rather than resetting it back to the placeholder's "inactive"/no-display.
test("mergeAgentStatusSnapshot preserves an extra Agent's live status and display across a refresh", () => {
  const extraId = "extra-agent";
  type ExtraTrackedAgent = {
    id: string;
    status: AgentStatusView;
    display?: AgentDisplaySnapshot;
    displayRevisionHighWater?: number;
  };
  const placeholder: ExtraTrackedAgent = {
    id: extraId,
    status: { value: "inactive", expiresAt: null },
  };
  const liveDisplay = display({ agentId: extraId });
  const live: ExtraTrackedAgent = {
    id: extraId,
    status: {
      value: "active",
      expiresAt: 90_000,
      ordering: { daemonInstanceId: "daemon-1", clientSeq: 1, observedAtMs: 1_000 },
    },
    display: liveDisplay,
    displayRevisionHighWater: liveDisplay.revision,
  };

  const refreshed = mergeAgentStatusSnapshot([live], mergeExtraAgents([], [placeholder]));

  expect(refreshed).toHaveLength(1);
  expect(refreshed[0]?.status).toEqual(live.status);
  expect(refreshed[0]?.display).toEqual(live.display);
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

test("tolerates a missing contextUsage field and validates it when present", () => {
  // Older server: no `contextUsage` key at all — omitted from the parsed result, not `null`.
  const parsed = parseAgentDisplaySnapshot({ type: "agent:display", ...display() });
  expect(parsed).not.toHaveProperty("contextUsage");

  const withUsage = display({
    contextUsage: { usedTokens: 27_908, windowTokens: 200_000, observedAtMs: 1_758_000_000_000 },
  });
  expect(parseAgentDisplaySnapshot({ type: "agent:display", ...withUsage })).toEqual(withUsage);

  const clearedUsage = display({ contextUsage: null });
  expect(parseAgentDisplaySnapshot({ type: "agent:display", ...clearedUsage })).toEqual(
    clearedUsage,
  );

  for (const invalid of [
    display({ contextUsage: { usedTokens: -1, windowTokens: 200_000, observedAtMs: 1 } }),
    display({ contextUsage: { usedTokens: 0, windowTokens: 0, observedAtMs: 1 } }),
    display({ contextUsage: { usedTokens: 0, windowTokens: 200_000, observedAtMs: 0 } }),
    display({ contextUsage: "not-an-object" as never }),
  ]) {
    expect(() => parseAgentDisplaySnapshot({ type: "agent:display", ...invalid })).toThrow();
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

test("nextDisplayRefreshDelayMs pushes a busy display's refresh past the probe timeout", () => {
  const now = 1_000_000;
  const workingAgent = {
    ...agents[0]!,
    display: display({ activityKind: "working", expiresAt: now + 40_000 }),
  };
  expect(nextDisplayRefreshDelayMs([workingAgent], now)).toBe(
    workingAgent.display.expiresAt! + ACTIVITY_PROBE_TIMEOUT_MS + 1_000 - now + 10,
  );
});

test("nextDisplayRefreshDelayMs keeps today's timing for non-busy displays", () => {
  const now = 1_000_000;
  for (const activityKind of ["online", "error", "offline"] as const) {
    const agent = { ...agents[0]!, display: display({ activityKind, expiresAt: 1_050_000 }) };
    expect(nextDisplayRefreshDelayMs([agent], now)).toBe(1_050_000 - now + 10);
  }
});

test("nextDisplayRefreshDelayMs floors an already-elapsed deadline and ignores agents without a display", () => {
  const now = 1_000_000;
  const elapsed = {
    ...agents[0]!,
    display: display({ activityKind: "online", expiresAt: 900_000 }),
  };
  expect(nextDisplayRefreshDelayMs([elapsed], now)).toBe(1_000);
  expect(nextDisplayRefreshDelayMs([agents[0]!], now)).toBeUndefined();
  expect(nextDisplayRefreshDelayMs([], now)).toBeUndefined();
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
