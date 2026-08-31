import { expect, test } from "bun:test";
import { RedisUsageCache } from "../src/server/centrifugo/usage-cache.server";

test("usage cache stores a non-empty normalized snapshot with a scoped TTL key", async () => {
  const values = new Map<string, string>();
  const calls: string[] = [];
  const redis = {
    async set(key: string, value: string, ex: "EX", seconds: string) {
      calls.push(`${key}:${ex}:${seconds}`);
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
  };
  const cache = new RedisUsageCache(redis, "60");
  await cache.put({
    workspaceId: "w1",
    computerId: "c1",
    provider: "codex",
    scanId: "s1",
    status: "available",
    snapshot: { planType: "pro", primary: { usedPercent: 12, resetsAt: "2026-01-01" } },
  });
  await expect(
    cache.get({ workspaceId: "w1", computerId: "c1", provider: "codex" }),
  ).resolves.toMatchObject({ scanId: "s1", snapshot: { planType: "pro" } });
  expect(calls[0]).toContain("coforge:usage:v1:w1:c1:codex:EX:60");
});
