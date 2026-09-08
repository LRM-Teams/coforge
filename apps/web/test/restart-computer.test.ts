import { expect, test } from "bun:test";
import { decodeComputerRestartIntent } from "@coforge/protocol";

import { RestartComputer } from "../src/server/computers/restart-computer.server";
import { RedisComputerRestartStore } from "../src/server/computers/computer-restart-store.server";

function memoryRedis(now = () => 0) {
  const values = new Map<string, string>();
  const expiresAt = new Map<string, number>();
  let beforeNextCompareAndSet: (() => Promise<void>) | undefined;
  let afterNextGet: (() => Promise<void>) | undefined;
  return {
    values,
    pauseNextCompareAndSet(pause: () => Promise<void>) {
      beforeNextCompareAndSet = pause;
    },
    pauseNextGet(pause: () => Promise<void>) {
      afterNextGet = pause;
    },
    async get(key: string) {
      if ((expiresAt.get(key) ?? Infinity) <= now()) {
        values.delete(key);
        expiresAt.delete(key);
      }
      const value = values.get(key) ?? null;
      const pause = afterNextGet;
      afterNextGet = undefined;
      await pause?.();
      return value;
    },
    async set(...args: string[]) {
      const [key, value] = args;
      if (!key || value === undefined) return null;
      if (args.includes("NX") && values.has(key)) return null;
      values.set(key, value);
      const ex = args.indexOf("EX");
      if (ex >= 0) expiresAt.set(key, now() + Number(args[ex + 1]) * 1_000);
      else expiresAt.delete(key);
      return "OK";
    },
    async send(_command: "EVAL", args: string[]) {
      const [, , key, expectedOrCandidate, replacement] = args;
      if (!key || !expectedOrCandidate) return 0;
      const pause = beforeNextCompareAndSet;
      beforeNextCompareAndSet = undefined;
      await pause?.();
      if (replacement !== undefined) {
        if (values.get(key) !== expectedOrCandidate) return 0;
        values.set(key, replacement);
        return 1;
      }
      const candidate = JSON.parse(expectedOrCandidate) as { startedAt: number };
      const currentValue = values.get(key);
      const current = currentValue
        ? (JSON.parse(currentValue) as { startedAt: number })
        : undefined;
      if (!current || candidate.startedAt > current.startedAt) {
        values.set(key, expectedOrCandidate);
        return 1;
      }
      return 0;
    },
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

test("publishes a restart only for a User's exact Workspace–Computer connection", async () => {
  const publications: Array<{ channel: string; data: Uint8Array }> = [];
  const redis = memoryRedis();
  const store = new RedisComputerRestartStore(redis);
  await store.ready(
    { workspaceId: "workspace-1", computerId: "computer-1" },
    { workerInstanceId: "worker-old", daemonVersion: "1.0.0", startedAt: 1 },
    [],
  );
  const restart = new RestartComputer(
    {
      canRestart: async ({ userId, workspaceId, computerId }) =>
        userId === "user-1" && workspaceId === "workspace-1" && computerId === "computer-1",
    },
    { publish: async (channel, data) => void publications.push({ channel, data }) },
    store,
  );

  await expect(
    restart.execute(
      { userId: "user-1", workspaceId: "workspace-2" },
      { computerId: "computer-1", requestId: "restart-1" },
    ),
  ).rejects.toThrow("Computer is not available");
  expect(publications).toEqual([]);

  expect(
    await restart.execute(
      { userId: "user-1", workspaceId: "workspace-1" },
      { computerId: "computer-1", requestId: "restart-1" },
    ),
  ).toMatchObject({ requestId: "restart-1", status: "accepted" });
  expect(publications[0]?.channel).toBe("daemon:workspace-1:computer-1");
  expect(decodeComputerRestartIntent(publications[0]!.data)).toMatchObject({
    requestId: "restart-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
  });
});

test("completes only with recovered evidence from a different process in the exact scope", async () => {
  let now = 1_000;
  const store = new RedisComputerRestartStore(memoryRedis(), () => now);
  const a = { workspaceId: "workspace-a", computerId: "computer-1" };
  const b = { workspaceId: "workspace-b", computerId: "computer-1" };
  await store.ready(a, { workerInstanceId: "old-a", daemonVersion: "1.0.0", startedAt: 1 }, []);
  await store.ready(b, { workerInstanceId: "old-b", daemonVersion: "1.0.0", startedAt: 1 }, []);
  await store.begin(a, "restart-a");

  await store.ready(a, { workerInstanceId: "new-a", daemonVersion: "2.0.0", startedAt: 2 }, []);
  expect((await store.status(a, "restart-a"))?.status).toBe("accepted");
  await store.ready(b, { workerInstanceId: "new-b", daemonVersion: "2.0.0", startedAt: 2 }, [
    "restart-a",
  ]);
  expect((await store.status(a, "restart-a"))?.status).toBe("accepted");
  await store.ready(a, { workerInstanceId: "old-a", daemonVersion: "2.0.0", startedAt: 3 }, [
    "restart-a",
  ]);
  expect((await store.status(a, "restart-a"))?.status).toBe("accepted");
  await store.ready(a, { workerInstanceId: "new-a", daemonVersion: "2.0.0", startedAt: 4 }, [
    "restart-a",
  ]);
  expect(await store.status(a, "restart-a")).toMatchObject({
    status: "completed",
    workerInstanceId: "new-a",
    daemonVersion: "2.0.0",
  });

  await store.begin(a, "restart-timeout");
  now += 60_001;
  expect(await store.status(a, "restart-timeout")).toEqual({
    requestId: "restart-timeout",
    status: "failed",
    reason: "timeout",
  });
});

test("keeps process identity available beyond the restart result lifetime", async () => {
  let now = 0;
  const redis = memoryRedis(() => now);
  const store = new RedisComputerRestartStore(redis, () => now);
  const scope = { workspaceId: "workspace-a", computerId: "computer-1" };
  await store.ready(
    scope,
    { workerInstanceId: "worker-1", daemonVersion: "1.0.0", startedAt: 1 },
    [],
  );

  now += 5 * 60_000 + 1;

  await expect(store.begin(scope, "restart-after-five-minutes")).resolves.toMatchObject({
    created: true,
    status: { status: "accepted" },
  });
});

test("a delayed publication failure cannot downgrade a completed restart", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerRestartStore(redis);
  const scope = { workspaceId: "workspace-a", computerId: "computer-1" };
  await store.ready(scope, { workerInstanceId: "old", daemonVersion: "1.0.0", startedAt: 1 }, []);
  await store.begin(scope, "restart-1");
  const gate = deferred();
  redis.pauseNextCompareAndSet(() => gate.promise);

  const failure = store.publicationFailed(scope, "restart-1");
  await store.ready(scope, { workerInstanceId: "new", daemonVersion: "2.0.0", startedAt: 2 }, [
    "restart-1",
  ]);
  gate.release();
  await failure;

  expect((await store.status(scope, "restart-1"))?.status).toBe("completed");
});

test("a delayed timeout cannot overwrite a concurrently completed restart", async () => {
  let now = 0;
  const redis = memoryRedis();
  const store = new RedisComputerRestartStore(redis, () => now);
  const scope = { workspaceId: "workspace-a", computerId: "computer-1" };
  await store.ready(scope, { workerInstanceId: "old", daemonVersion: "1.0.0", startedAt: 1 }, []);
  await store.begin(scope, "restart-1");
  now = 60_001;
  const gate = deferred();
  redis.pauseNextGet(() => gate.promise);

  const timedOutStatus = store.status(scope, "restart-1");
  now = 1;
  await store.ready(scope, { workerInstanceId: "new", daemonVersion: "2.0.0", startedAt: 2 }, [
    "restart-1",
  ]);
  now = 60_001;
  gate.release();

  expect((await timedOutStatus)?.status).toBe("completed");
  expect((await store.status(scope, "restart-1"))?.status).toBe("completed");
});

test("a late ready cannot replace a newer process identity", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerRestartStore(redis);
  const scope = { workspaceId: "workspace-a", computerId: "computer-1" };
  await store.ready(
    scope,
    { workerInstanceId: "initial", daemonVersion: "1.0.0", startedAt: 1 },
    [],
  );
  const gate = deferred();
  redis.pauseNextCompareAndSet(() => gate.promise);

  const staleReady = store.ready(
    scope,
    { workerInstanceId: "stale", daemonVersion: "1.1.0", startedAt: 2 },
    [],
  );
  await store.ready(
    scope,
    { workerInstanceId: "newest", daemonVersion: "2.0.0", startedAt: 3 },
    [],
  );
  gate.release();
  await staleReady;
  await store.begin(scope, "restart-1");
  await store.ready(scope, { workerInstanceId: "newest", daemonVersion: "2.0.0", startedAt: 3 }, [
    "restart-1",
  ]);

  expect((await store.status(scope, "restart-1"))?.status).toBe("accepted");
});
