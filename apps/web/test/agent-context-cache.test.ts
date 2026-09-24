import { expect, test } from "bun:test";
import {
  RedisAgentContextCache,
  AGENT_CONTEXT_STALE_AFTER_MS,
} from "#src/server/centrifugo/agent-context-cache.server";

function fakeRedis() {
  const values = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    values,
    async set(key: string, value: string, ex: "EX", seconds: string) {
      calls.push(`set:${key}:${ex}:${seconds}`);
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (values.delete(key)) removed += 1;
      calls.push(`del:${keys.join(",")}`);
      return removed;
    },
  };
}

const key = { workspaceId: "w1", computerId: "c1", agentId: "a1" };

const report = {
  provider: "claude-code" as const,
  usedTokens: 24_900,
  windowTokens: 200_000,
  observedAt: "2026-09-18T00:00:00Z",
  categories: [{ name: "Free space", tokens: 175_100 }],
};

test("a missing key reports state missing with no result", async () => {
  const cache = new RedisAgentContextCache(fakeRedis());
  await expect(cache.read(key)).resolves.toEqual({ state: "missing" });
});

test("a result within the stale window reads back fresh, scoped per Agent", async () => {
  const redis = fakeRedis();
  const cache = new RedisAgentContextCache(redis, "86400", "60", () =>
    Date.parse("2026-09-18T00:00:00Z"),
  );
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    report,
    collectedAt: "2026-09-18T00:00:00Z",
  });
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "fresh",
    result: { scanId: "scan-1", report },
  });
  expect(redis.calls[0]).toContain(
    "coforge:workspace:w1:computer:c1:agent:a1:context-report:v1:result:EX:86400",
  );
});

test("a result older than the stale window reads back stale, not missing", async () => {
  const cache = new RedisAgentContextCache(fakeRedis(), "86400", "60", () =>
    Date.parse("2026-09-18T01:00:00Z"),
  );
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    collectedAt: new Date(
      Date.parse("2026-09-18T01:00:00Z") - AGENT_CONTEXT_STALE_AFTER_MS - 1,
    ).toISOString(),
  });
  await expect(cache.read(key)).resolves.toMatchObject({ state: "stale" });
});

test("starting a new scan never erases the previous result, and completion clears the marker", async () => {
  const cache = new RedisAgentContextCache(fakeRedis());
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    report,
    collectedAt: new Date().toISOString(),
  });
  await cache.putScan({ ...key, scanId: "scan-2", status: "pending" });
  const pending = await cache.read(key);
  expect(pending.result?.scanId).toBe("scan-1");
  expect(pending.pendingScanId).toBe("scan-2");

  await cache.putResult({
    ...key,
    scanId: "scan-2",
    status: "available",
    report,
    collectedAt: new Date().toISOString(),
  });
  const completed = await cache.read(key);
  expect(completed.pendingScanId).toBeUndefined();
  expect(completed.result?.scanId).toBe("scan-2");
});

test("a non-available result stores the daemon's reason for the popover to show", async () => {
  const cache = new RedisAgentContextCache(fakeRedis());
  await cache.putResult({
    ...key,
    scanId: "scan-3",
    status: "no_session",
    message: "Start the Agent first",
    collectedAt: new Date().toISOString(),
  });
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "fresh",
    result: { status: "no_session", message: "Start the Agent first" },
  });
  expect((await cache.read(key)).result).not.toHaveProperty("report");
});
