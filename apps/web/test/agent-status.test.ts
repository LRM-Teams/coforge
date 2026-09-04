import { expect, test } from "bun:test";

import { RedisAgentStatusCache } from "../src/server/agents/agent-status.server";

test("returns the latest volatile Agent availability status from shared hot state", async () => {
  const values = new Map<string, string>();
  const remaining = new Map<string, number>();
  const leases: Array<{ value: string; seconds: string }> = [];
  const cache = new RedisAgentStatusCache({
    set: async (key, value, _ex, seconds) => {
      values.set(key, value);
      remaining.set(key, Number(seconds));
      leases.push({ value, seconds });
    },
    get: async (key) => values.get(key) ?? null,
    ttl: async (key) => remaining.get(key) ?? -2,
    del: async (key) => {
      remaining.delete(key);
      return values.delete(key);
    },
  });
  const scope = {
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
  };
  expect(await cache.get(scope)).toBe("inactive");
  await cache.put({ ...scope, status: "active" });
  expect(await cache.get(scope)).toBe("active");
  expect(await cache.snapshot(scope, 1_000)).toEqual({
    status: "active",
    expiresAt: 91_000,
  });
  expect(leases).toEqual([{ value: "active", seconds: "90" }]);
  await cache.put({ ...scope, status: "inactive" });
  expect(await cache.get(scope)).toBe("inactive");
  expect(await cache.snapshot(scope, 1_000)).toEqual({
    status: "inactive",
    expiresAt: null,
  });
});
