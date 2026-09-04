import { expect, test } from "bun:test";

import { RedisAgentStatusCache } from "../src/server/agents/agent-status.server";

test("returns the latest volatile Agent availability status from shared hot state", async () => {
  const values = new Map<string, string>();
  const remaining = new Map<string, number>();
  const leases: Array<{ value: string; seconds: string }> = [];
  const cache = new RedisAgentStatusCache({
    eval: async (
      _script,
      numberOfKeys,
      key,
      value,
      daemonInstanceId,
      clientSeq,
      observedAtMs,
      status,
      seconds,
    ) => {
      expect(numberOfKeys).toBe(1);
      const current = values.get(String(key));
      const next = JSON.parse(String(value));
      expect([daemonInstanceId, clientSeq, observedAtMs, status]).toEqual([
        next.daemonInstanceId,
        next.clientSeq,
        next.observedAtMs,
        next.status,
      ]);
      if (current) {
        const previous = JSON.parse(current);
        const accepted =
          previous.daemonInstanceId === next.daemonInstanceId
            ? next.clientSeq > previous.clientSeq ||
              (next.clientSeq === previous.clientSeq &&
                next.status === previous.status &&
                next.observedAtMs === previous.observedAtMs)
            : next.observedAtMs > previous.observedAtMs;
        if (!accepted) return 0;
      }
      values.set(String(key), String(value));
      remaining.set(String(key), Number(seconds));
      leases.push({ value: String(value), seconds: String(seconds) });
      return 1;
    },
    get: async (key) => values.get(key) ?? null,
    ttl: async (key) => remaining.get(key) ?? -2,
  });
  const scope = {
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
  };
  expect(await cache.get(scope)).toBe("inactive");
  await cache.put({
    ...scope,
    status: "active",
    daemonInstanceId: "daemon-1",
    clientSeq: 1,
    observedAtMs: 100,
  });
  expect(await cache.get(scope)).toBe("active");
  expect(await cache.snapshot(scope, 1_000)).toEqual({
    status: "active",
    expiresAt: 91_000,
    daemonInstanceId: "daemon-1",
    clientSeq: 1,
    observedAtMs: 100,
  });
  expect(leases).toEqual([
    {
      value: JSON.stringify({
        status: "active",
        daemonInstanceId: "daemon-1",
        clientSeq: 1,
        observedAtMs: 100,
      }),
      seconds: "90",
    },
  ]);
  expect(
    await cache.put({
      ...scope,
      status: "active",
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      observedAtMs: 100,
    }),
  ).toBe(true);
  expect(
    await cache.put({
      ...scope,
      status: "inactive",
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      observedAtMs: 100,
    }),
  ).toBe(false);
  expect(
    await cache.put({
      ...scope,
      status: "inactive",
      daemonInstanceId: "daemon-1",
      clientSeq: 0,
      observedAtMs: 50,
    }),
  ).toBe(false);
  expect(
    await cache.put({
      ...scope,
      status: "active",
      daemonInstanceId: "daemon-2",
      clientSeq: 1,
      observedAtMs: 99,
    }),
  ).toBe(false);
  expect(
    await cache.put({
      ...scope,
      status: "active",
      daemonInstanceId: "daemon-2",
      clientSeq: 1,
      observedAtMs: 101,
    }),
  ).toBe(true);
  expect(
    await cache.put({
      ...scope,
      status: "inactive",
      daemonInstanceId: "daemon-1",
      clientSeq: 2,
      observedAtMs: 100,
    }),
  ).toBe(false);
  expect(await cache.get(scope)).toBe("active");
  expect(await cache.snapshot(scope, 1_000)).toEqual({
    status: "active",
    expiresAt: 91_000,
    daemonInstanceId: "daemon-2",
    clientSeq: 1,
    observedAtMs: 101,
  });
});

test("ignores structurally invalid external Redis records", async () => {
  const cache = new RedisAgentStatusCache({
    eval: async () => 0,
    get: async () => JSON.stringify({ status: "active", clientSeq: "newest" }),
    ttl: async () => 90,
  });
  const scope = { workspaceId: "workspace", computerId: "computer", agentId: "agent" };
  expect(await cache.get(scope)).toBe("inactive");
  expect(await cache.snapshot(scope)).toBeUndefined();
});
