import { expect, test } from "bun:test";

import {
  COMPUTER_STATUS_LEASE_MS,
  RedisComputerStatusCache,
} from "#src/server/centrifugo/computer-status.server";

test("stores Computer status in a scoped Redis lease", async () => {
  const writes: Array<[string, string, string, string]> = [];
  const values = new Map<string, string>();
  const cache = new RedisComputerStatusCache({
    set: async (...args) => {
      writes.push(args);
      values.set(args[0], args[1]);
    },
    get: async (key) => values.get(key) ?? null,
    mget: async (...keys) => keys.map((key) => values.get(key) ?? null),
  });

  await cache.put({ workspaceId: "workspace-1", computerId: "computer-1" }, true);

  expect(writes).toEqual([
    ["coforge:workspace:workspace-1:computer:computer-1:status:v1", "online", "EX", "90"],
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
    mget: async (...keys) => keys.map((key) => values.get(key) ?? null),
  });
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

  await cache.put(scope, true);
  await cache.put(scope, false);

  expect(await cache.get(scope)).toBe(false);
});

test("getMany reads every Computer's lease in one round trip, missing keys offline", async () => {
  const values = new Map<string, string>();
  const mgets: string[][] = [];
  const cache = new RedisComputerStatusCache({
    set: async (key, value) => void values.set(key, value),
    get: async (key) => values.get(key) ?? null,
    mget: async (...keys) => {
      mgets.push([...keys]);
      return keys.map((key) => values.get(key) ?? null);
    },
  });
  const online = { workspaceId: "workspace-1", computerId: "computer-1" };
  const offline = { workspaceId: "workspace-1", computerId: "computer-2" };
  const otherWorkspace = { workspaceId: "workspace-2", computerId: "computer-1" };

  await cache.put(online, true);
  await cache.put(offline, false);

  expect(await cache.getMany([online, offline, otherWorkspace])).toEqual([true, false, false]);
  expect(mgets).toHaveLength(1);
  expect(mgets[0]).toEqual([
    "coforge:workspace:workspace-1:computer:computer-1:status:v1",
    "coforge:workspace:workspace-1:computer:computer-2:status:v1",
    "coforge:workspace:workspace-2:computer:computer-1:status:v1",
  ]);
  expect(await cache.getMany([])).toEqual([]);
});
