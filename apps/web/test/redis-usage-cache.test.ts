import { expect, test } from "bun:test";
import { RedisUsageCache, USAGE_STALE_AFTER_MS } from "#src/server/centrifugo/usage-cache.server";

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
    // PUT_RESULT: KEYS = [result key, scan key], ARGV = [encoded result, ttl seconds].
    async eval(_script: string, numberOfKeys: number, ...keysAndArgs: Array<string | number>) {
      expect(numberOfKeys).toBe(2);
      values.set(String(keysAndArgs[0]), String(keysAndArgs[2]));
      values.delete(String(keysAndArgs[1]));
      calls.push(`eval:${keysAndArgs[0]}:EX:${keysAndArgs[3]}:del:${keysAndArgs[1]}`);
      return 1;
    },
  };
}

const key = { workspaceId: "w1", computerId: "c1", provider: "codex" as const };

test("a missing key reports state missing with no result", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis);
  await expect(cache.read(key)).resolves.toEqual({ state: "missing" });
});

test("a result within the stale window reads back fresh, scoped to a versioned per-provider key", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis, "86400", "60", () => Date.parse("2026-09-17T00:00:00Z"));
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex", planType: "pro" },
    collectedAt: "2026-09-17T00:00:00Z",
  });
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "fresh",
    result: { scanId: "scan-1", snapshot: { planType: "pro" } },
  });
  expect(redis.calls[0]).toContain(
    "coforge:workspace:w1:computer:c1:usage:v2:codex:result:EX:86400",
  );
});

test("a result older than the stale window reads back stale, not missing", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis, "86400", "60", () => Date.parse("2026-09-17T01:00:00Z"));
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    collectedAt: new Date(
      Date.parse("2026-09-17T01:00:00Z") - USAGE_STALE_AFTER_MS - 1,
    ).toISOString(),
  });
  await expect(cache.read(key)).resolves.toMatchObject({ state: "stale" });
});

test("starting a new scan never erases the previous result", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex", planType: "pro" },
    collectedAt: new Date().toISOString(),
  });
  await cache.putScan({ ...key, scanId: "scan-2", status: "pending" });

  const read = await cache.read(key);
  expect(read.result?.scanId).toBe("scan-1");
  expect(read.result?.snapshot?.planType).toBe("pro");
  expect(read.pendingScanId).toBe("scan-2");
});

test("a completed scan clears its own pending marker so it stops reporting as pending", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis);
  await cache.putScan({ ...key, scanId: "scan-1", status: "pending" });
  expect((await cache.read(key)).pendingScanId).toBe("scan-1");

  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    collectedAt: new Date().toISOString(),
  });
  const read = await cache.read(key);
  expect(read.pendingScanId).toBeUndefined();
  expect(read.result?.scanId).toBe("scan-1");
});

test("an old Daemon's result without its own collectedAt still carries the server-assigned one", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis, "86400", "60", () => Date.parse("2026-09-17T00:00:00Z"));
  // The caller (the scan-result RPC method) is what falls back to server-receive time when the
  // snapshot itself is silent; the cache just stores and classifies whatever `collectedAt` it's
  // given.
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex" },
    collectedAt: "2026-09-17T00:00:00.000Z",
  });
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "fresh",
    result: { collectedAt: "2026-09-17T00:00:00.000Z" },
  });
});

test("clears an in-flight scan and writes its result in one round trip", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis, "86400", "60", () => Date.parse("2026-09-17T00:00:00Z"));
  await cache.putScan({ ...key, scanId: "scan-1", status: "pending" });
  // A pending scan is what a read reports as still in flight.
  expect((await cache.read(key)).pendingScanId).toBe("scan-1");
  redis.calls.length = 0;

  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex" },
    collectedAt: "2026-09-17T00:00:00Z",
  });

  // One call that both writes the result (with its TTL) and drops the scan marker — not a set
  // followed by a separate del.
  expect(redis.calls).toHaveLength(1);
  expect(redis.calls[0]).toMatch(/^eval:/);
  expect(redis.calls[0]).toContain(":EX:86400:");
  expect(redis.calls[0]).toContain(":del:");
  // And the read that follows no longer reports the scan as pending, while the result is there.
  const read = await cache.read(key);
  expect(read.pendingScanId).toBeUndefined();
  expect(read).toMatchObject({ state: "fresh", result: { scanId: "scan-1" } });
});
