import { expect, test } from "bun:test";

import {
  COMPUTER_STATUS_LEASE_MS,
  RedisComputerStatusCache,
} from "../src/server/centrifugo/computer-status.server";

test("stores Computer status in a scoped Redis lease", async () => {
  const writes: Array<[string, string, string, string]> = [];
  const values = new Map<string, string>();
  const cache = new RedisComputerStatusCache({
    set: async (...args) => {
      writes.push(args);
      values.set(args[0], args[1]);
    },
    get: async (key) => values.get(key) ?? null,
  });

  await cache.put({ workspaceId: "workspace-1", computerId: "computer-1" }, true);

  expect(writes).toEqual([
    ["coforge:computer-status:v1:workspace-1:computer-1", "online", "EX", "90"],
  ]);
  expect(COMPUTER_STATUS_LEASE_MS).toBe(90_000);
  expect(await cache.get({ workspaceId: "workspace-1", computerId: "computer-1" })).toBe(true);
  expect(await cache.get({ workspaceId: "workspace-2", computerId: "computer-1" })).toBe(false);
});

test("stores an explicit offline status instead of leaving an online lease", async () => {
  const values = new Map<string, string>();
  const cache = new RedisComputerStatusCache({
    set: async (key, value) => void values.set(key, value),
    get: async (key) => values.get(key) ?? null,
  });
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

  await cache.put(scope, true);
  await cache.put(scope, false);

  expect(await cache.get(scope)).toBe(false);
});
