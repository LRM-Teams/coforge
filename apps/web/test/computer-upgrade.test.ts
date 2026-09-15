import { expect, test } from "bun:test";
import { RedisComputerUpgradeStore } from "../src/server/computers/computer-upgrade-store.server";

function memoryRedis() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (...args: string[]) => {
      const [key, value, , , mode] = args;
      if (mode === "NX" && values.has(key!)) return null;
      values.set(key!, value!);
      return "OK";
    },
    send: async (_command: "EVAL", args: string[]) => {
      if (args.length === 5) {
        const [, , key, candidate] = args;
        const current = values.get(key!);
        if (!current || JSON.parse(current).startedAt <= JSON.parse(candidate!).startedAt)
          values.set(key!, candidate!);
        return 1;
      }
      if (args[1] === "2") {
        const [, , requestKey, identityKey, expected, identity, value] = args;
        if (values.get(requestKey!) !== expected) return 0;
        values.set(identityKey!, identity!);
        values.set(requestKey!, value!);
        return 1;
      }
      const [, , key, expected, value] = args;
      if (values.get(key!) !== expected) return 0;
      values.set(key!, value!);
      return 1;
    },
    values,
  };
}

test("upgrade completion requires the same request, concrete version, fresh worker, and matching versions", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(
    scope,
    { workerInstanceId: "old", computerVersion: "1.0.0", daemonVersion: "1.0.0", startedAt: 1 },
    [],
  );
  await store.begin(scope, "request", "2.0.0");
  await store.ready(
    scope,
    { workerInstanceId: "new", computerVersion: "2.0.0", daemonVersion: "2.0.0", startedAt: 2 },
    ["other"],
  );
  expect((await store.status(scope, "request"))?.status).toBe("accepted");
  await store.ready(
    scope,
    { workerInstanceId: "new", computerVersion: "2.0.0", daemonVersion: "2.0.0", startedAt: 2 },
    ["request"],
  );
  expect(await store.status(scope, "request")).toMatchObject({
    status: "completed",
    expectedVersion: "2.0.0",
  });
});

test("mismatched ready versions fail closed instead of completing", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(
    scope,
    { workerInstanceId: "old", computerVersion: "1.0.0", daemonVersion: "1.0.0", startedAt: 1 },
    [],
  );
  await store.begin(scope, "request", "2.0.0");
  await store.ready(
    scope,
    { workerInstanceId: "new", computerVersion: "2.0.0", daemonVersion: "1.9.0", startedAt: 2 },
    ["request"],
  );
  expect((await store.status(scope, "request"))?.status).toBe("failed");
});
