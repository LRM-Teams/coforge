import { expect, test } from "bun:test";

import {
  applyAgentStatusEvent,
  decodeAgentStatusEvent,
  expireAgentStatuses,
  mergeAgentStatusSnapshot,
  type AgentStatusEvent,
  type AgentStatusView,
} from "../src/features/agents/agent-status-realtime";

const ordering = { daemonInstanceId: "daemon-1", clientSeq: 2, observedAtMs: 2_000 };
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
      { id: "agent-1", name: "Renamed", status: { value: "inactive" as const, expiresAt: null } },
      { id: "agent-2", name: "Added", status: { value: "inactive" as const, expiresAt: null } },
    ]),
  ).toEqual([
    { ...agents[0], name: "Renamed" },
    { id: "agent-2", name: "Added", status: { value: "inactive", expiresAt: null } },
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
