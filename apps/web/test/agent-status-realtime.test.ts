import { expect, mock, test } from "bun:test";

import {
  applyAgentStatusEvent,
  createAgentStatusConnectedHandler,
  decodeAgentStatusEvent,
  expireAgentStatuses,
} from "../src/features/agents/agent-status-realtime";

const agents = [
  {
    id: "agent-1",
    status: "inactive" as const,
    statusExpiresAt: null,
  },
];

test("applies a realtime status event only to its Agent", () => {
  expect(
    applyAgentStatusEvent(agents, {
      agentId: "agent-1",
      status: "active",
      expiresAt: 90_000,
    }),
  ).toEqual([{ id: "agent-1", status: "active", statusExpiresAt: 90_000 }]);
});

test("expires an active Agent locally when its lease renewal stops", () => {
  expect(
    expireAgentStatuses([{ id: "agent-1", status: "active", statusExpiresAt: 90_000 }], 90_001),
  ).toEqual([{ id: "agent-1", status: "inactive", statusExpiresAt: null }]);
});

test("rejects malformed realtime status publications", () => {
  const valid = new TextEncoder().encode(
    JSON.stringify({ agentId: "agent-1", status: "active", expiresAt: 90_000 }),
  );
  expect(decodeAgentStatusEvent(valid)).toEqual({
    agentId: "agent-1",
    status: "active",
    expiresAt: 90_000,
  });
  expect(
    decodeAgentStatusEvent({ agentId: "agent-1", status: "inactive", expiresAt: null }),
  ).toEqual({ agentId: "agent-1", status: "inactive", expiresAt: null });
  expect(() => decodeAgentStatusEvent(new TextEncoder().encode('{"status":"online"}'))).toThrow();
});

test("refreshes the Agent snapshot on the initial connection and every reconnect", async () => {
  const snapshots = [[{ id: "agent-1" }], [{ id: "agent-2" }]];
  const refresh = mock(async () => snapshots.shift() ?? []);
  const apply = mock((_agents: Array<{ id: string }>) => {});
  const connected = createAgentStatusConnectedHandler(refresh, apply);

  await connected();
  await connected();

  expect(refresh).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls.map(([agents]) => agents)).toEqual([
    [{ id: "agent-1" }],
    [{ id: "agent-2" }],
  ]);
});
