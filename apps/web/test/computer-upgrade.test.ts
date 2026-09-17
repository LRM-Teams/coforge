import { expect, test } from "bun:test";
import { RedisComputerUpgradeStore } from "../src/server/computers/computer-upgrade-store.server";

function memoryRedis(seed?: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(seed ?? {}));
  const sends: string[][] = [];
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (...args: string[]) => {
      const [key, value, , , mode] = args;
      if (mode === "NX" && values.has(key!)) return null;
      values.set(key!, value!);
      return "OK";
    },
    send: async (_command: "EVAL", args: string[]) => {
      sends.push(args);
      if (args.length === 4) {
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
    sends,
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

test("a Computer with no identity on record fails an upgrade request with its own typed error, not offline", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };

  await expect(store.begin(scope, "request", "2.0.0")).rejects.toMatchObject({
    name: "AppError",
    code: "COMPUTER_IDENTITY_UNKNOWN",
  });
});

test("touchIdentity on a Computer that has no identity on record is a no-op, not a fabricated identity", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };

  await store.touchIdentity(scope);

  await expect(store.begin(scope, "request", "2.0.0")).rejects.toMatchObject({
    code: "COMPUTER_IDENTITY_UNKNOWN",
  });
});

test("identity written by ready() is stored without an expiry", async () => {
  const scope = { workspaceId: "w", computerId: "c" };
  const identityKey = "coforge:workspace:w:computer:c:upgrade:v1:identity";
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);

  await store.ready(scope, identity("worker-1", "1.0.0", 1), []);

  // storeNewerIdentity's EVAL call: [script, numkeys, identityKey, identityJson] - no EX/TTL arg.
  expect(redis.sends).toHaveLength(1);
  expect(redis.sends[0]).toEqual([expect.any(String), "1", identityKey, expect.any(String)]);
  await expect(store.identity(scope)).resolves.toMatchObject({ workerInstanceId: "worker-1" });
});

test("touchIdentity re-persists a stored identity without an expiry, and does nothing for a missing key", async () => {
  const scope = { workspaceId: "w", computerId: "c" };
  const identityKey = "coforge:workspace:w:computer:c:upgrade:v1:identity";
  const redis = memoryRedis({ [identityKey]: JSON.stringify(identity("worker-1", "1.0.0", 1)) });
  const store = new RedisComputerUpgradeStore(redis, () => 1000);

  await store.touchIdentity(scope);

  // No EX/TTL argument: [script, numkeys, identityKey, storedIdentityJson].
  expect(redis.sends).toHaveLength(1);
  expect(redis.sends[0]).toEqual([
    expect.any(String),
    "1",
    identityKey,
    JSON.stringify(identity("worker-1", "1.0.0", 1)),
  ]);
  await expect(store.identity(scope)).resolves.toMatchObject({ workerInstanceId: "worker-1" });

  // A missing identity key is a no-op, not a fabricated identity.
  redis.values.delete(identityKey);
  redis.sends.length = 0;
  await store.touchIdentity(scope);
  expect(redis.sends).toHaveLength(0);
});

test("a stale touchIdentity never clobbers a newer identity a concurrent ready() already wrote", async () => {
  const scope = { workspaceId: "w", computerId: "c" };
  const identityKey = "coforge:workspace:w:computer:c:upgrade:v1:identity";
  // touchIdentity's own read returns what it saw a moment ago; a fresher `ready()` has since
  // landed in the store underneath it.
  const staleRaw = JSON.stringify(identity("old-worker", "1.0.0", 1));
  const values = new Map<string, string>([
    [identityKey, JSON.stringify(identity("new-worker", "2.0.0", 2))],
  ]);
  const redis = {
    get: async (key: string) => (key === identityKey ? staleRaw : (values.get(key) ?? null)),
    set: async () => "OK",
    send: async (_command: "EVAL", args: string[]) => {
      const [, , key, candidateRaw] = args;
      const current = values.get(key!);
      if (current) {
        const previous = JSON.parse(current) as { startedAt: number; workerInstanceId: string };
        const candidate = JSON.parse(candidateRaw!) as {
          startedAt: number;
          workerInstanceId: string;
        };
        if (
          previous.startedAt > candidate.startedAt ||
          (previous.startedAt === candidate.startedAt &&
            previous.workerInstanceId !== candidate.workerInstanceId)
        )
          return 0;
      }
      values.set(key!, candidateRaw!);
      return 1;
    },
  };
  const store = new RedisComputerUpgradeStore(redis, () => 1000);

  await store.touchIdentity(scope);

  expect(JSON.parse(values.get(identityKey)!)).toMatchObject({ workerInstanceId: "new-worker" });
});
