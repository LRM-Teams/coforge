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

const identity = (workerInstanceId: string, version: string, startedAt: number) => ({
  workerInstanceId,
  computerVersion: version,
  daemonVersion: version,
  startedAt,
});

test("a reported failure is authoritative and carries its sanitized reason", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  await store.begin(scope, "request", "2.0.0");

  await store.reported(scope, {
    requestId: "request",
    status: "failed",
    error: "candidate failed at /Users/someone/.coforge; token abcdefghijklmnopqrstuvwxyz",
    completedAtMs: 1000,
  });

  const status = await store.status(scope, "request");
  expect(status).toMatchObject({ status: "failed", reason: "reported" });
  const failure = status as { error?: string };
  expect(failure.error).toContain("<path>");
  expect(failure.error).toContain("<redacted>");
  expect(failure.error).not.toContain("/Users/");
});

test("a reported success alone never completes an upgrade without identity evidence", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  await store.begin(scope, "request", "2.0.0");

  await store.reported(scope, {
    requestId: "request",
    status: "succeeded",
    version: "2.0.0",
    completedAtMs: 1000,
  });

  // The Computer has not come back with its new identity yet, so nothing is proven.
  expect((await store.status(scope, "request"))?.status).toBe("accepted");

  await store.ready(scope, identity("new", "2.0.0", 2), ["request"]);
  expect(await store.status(scope, "request")).toMatchObject({
    status: "completed",
    expectedVersion: "2.0.0",
  });
});

test("a reported success that disagrees with the new identity does not complete", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  await store.begin(scope, "request", "2.0.0");

  await store.reported(scope, {
    requestId: "request",
    status: "succeeded",
    version: "1.9.9",
    completedAtMs: 1000,
  });

  expect((await store.status(scope, "request"))?.status).toBe("accepted");
});

test("a reported result cannot overwrite a settled request", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  await store.begin(scope, "request", "2.0.0");
  await store.ready(scope, identity("new", "2.0.0", 2), ["request"]);
  expect((await store.status(scope, "request"))?.status).toBe("completed");

  await store.reported(scope, {
    requestId: "request",
    status: "failed",
    error: "late and wrong",
    completedAtMs: 2000,
  });

  expect((await store.status(scope, "request"))?.status).toBe("completed");
});
