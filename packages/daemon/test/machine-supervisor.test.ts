import { expect, test } from "bun:test";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";
import {
  MachineSupervisor,
  UPGRADE_OPERATION_HISTORY,
  type ManagedBinding,
  type PendingUpgradeSettler,
} from "../src/supervisor/machine-supervisor";
import {
  UpgradeLaunchesPausedError,
  UpgradeOperationPendingError,
} from "../src/supervisor/upgrade-error";

const NOW = 1_700_000_000_000;

function upgradeFixture(
  initial: Partial<ManagedBinding> = {},
  settlePendingUpgrade?: PendingUpgradeSettler,
) {
  const state = {
    saved: [
      { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true, ...initial },
    ] as ManagedBinding[],
  };
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(state.saved),
      save: async (next) => {
        state.saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => {}, instance: async () => "a" },
    () => NOW,
    {},
    settlePendingUpgrade,
  );
  return { state, supervisor, operations: () => state.saved[0]?.upgradeOperations };
}

test("paused recovery loads bindings without starting them, then resume reconciles the set", async () => {
  const calls: string[] = [];
  const bindings: ManagedBinding[] = [
    { workspaceId: "running", computerId: "c", workspaceRoot: "/running", enabled: true },
    { workspaceId: "stopped", computerId: "c", workspaceRoot: "/stopped", enabled: false },
  ];
  const supervisor = new MachineSupervisor(
    { load: async () => structuredClone(bindings), save: async () => {} },
    {
      start: async (binding) => {
        calls.push(`start:${binding.workspaceId}`);
        return `instance:${binding.workspaceId}`;
      },
      stop: async (binding) => {
        calls.push(`stop:${binding.workspaceId}`);
      },
      instance: async () => null,
    },
  );

  await supervisor.recover({ paused: true });
  expect(calls).toEqual([]);
  await expect(
    supervisor.configure({ workspaceId: "new", computerId: "c", workspaceRoot: "/new" }),
  ).rejects.toBeInstanceOf(UpgradeLaunchesPausedError);

  await supervisor.resume();
  expect(calls).toEqual(["start:running", "stop:stopped"]);
});

test("reconcile restarts an enabled Workspace whose OS instance went inactive", async () => {
  let live: string | null = "instance-1";
  const starts: string[] = [];
  const bindings: ManagedBinding[] = [
    { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true },
  ];
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(bindings),
      save: async (next) => {
        bindings.splice(0, bindings.length, ...structuredClone(next));
      },
    },
    {
      start: async () => {
        starts.push(live === null ? "respawn" : "initial");
        live = `instance-${starts.length}`;
        return live;
      },
      stop: async () => {
        live = null;
      },
      instance: async () => live,
    },
  );

  await supervisor.recover();
  expect(starts).toEqual(["initial"]);
  live = null;
  await supervisor.reconcile();
  expect(starts).toEqual(["initial", "respawn"]);
  expect(live!).toBe("instance-2");
});

test("reconcile is a no-op while paused for upgrade", async () => {
  const starts: string[] = [];
  const supervisor = new MachineSupervisor(
    {
      load: async () => [{ workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true }],
      save: async () => {},
    },
    {
      start: async () => {
        starts.push("start");
        return "instance";
      },
      stop: async () => {},
      instance: async () => null,
    },
  );
  await supervisor.recover({ paused: true });
  await supervisor.reconcile();
  expect(starts).toEqual([]);
});

test("only one upgrade operation may be pending, and a replay is not a second launch", async () => {
  const { supervisor, operations } = upgradeFixture();
  await supervisor.recover();

  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3-rc.1")).toBe(true);
  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3-rc.1")).toBe(false);
  await expect(supervisor.recordUpgrade("a", "request-a", "9.9.9")).rejects.toThrow(
    "different expected version",
  );
  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.3")).rejects.toThrow(
    "request-a is still pending",
  );
  expect(operations()).toEqual([
    { requestId: "request-a", expectedVersion: "1.2.3-rc.1", state: "pending", requestedAt: NOW },
  ]);
});

test("recordUpgrade's pending refusal is a typed error carrying UPGRADE_OPERATION_PENDING", async () => {
  const { supervisor } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  const rejection = await supervisor
    .recordUpgrade("a", "request-b", "1.2.4")
    .catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(UpgradeOperationPendingError);
  expect((rejection as UpgradeOperationPendingError).code).toBe(
    UPGRADE_ERROR_CODE.OPERATION_PENDING,
  );
});

test("configure's pause refusal is a typed error carrying UPGRADE_LAUNCHES_PAUSED", async () => {
  const { supervisor } = upgradeFixture();
  await supervisor.recover();
  await supervisor.pause();

  const rejection = await supervisor
    .configure({ workspaceId: "b", computerId: "c", workspaceRoot: "/b" })
    .catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(UpgradeLaunchesPausedError);
  expect((rejection as UpgradeLaunchesPausedError).code).toBe(UPGRADE_ERROR_CODE.LAUNCHES_PAUSED);
});

test("recordUpgrade settles an already-receipted pending operation instead of refusing, then accepts the new request", async () => {
  const settleCalls: [string, string, number][] = [];
  const { supervisor, operations } = upgradeFixture(
    {},
    async (workspaceId, requestId, requestedAt) => {
      settleCalls.push([workspaceId, requestId, requestedAt]);
      return { status: "succeeded", version: "1.2.3-rc.1", at: NOW };
    },
  );
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3-rc.1");

  expect(await supervisor.recordUpgrade("a", "request-b", "1.2.4")).toBe(true);
  expect(settleCalls).toEqual([["a", "request-a", NOW]]);
  expect(operations()).toEqual([
    {
      requestId: "request-a",
      expectedVersion: "1.2.3-rc.1",
      state: "succeeded",
      requestedAt: NOW,
      terminal: { version: "1.2.3-rc.1", at: NOW },
    },
    { requestId: "request-b", expectedVersion: "1.2.4", state: "pending", requestedAt: NOW },
  ]);
});

test("recordUpgrade still refuses when the settle check reports the pending operation is genuinely in flight", async () => {
  const { supervisor, operations } = upgradeFixture({}, async () => undefined);
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
  expect(operations()).toEqual([
    { requestId: "request-a", expectedVersion: "1.2.3", state: "pending", requestedAt: NOW },
  ]);
});

test("recordUpgrade still refuses when the settle check itself fails", async () => {
  const { supervisor, operations } = upgradeFixture({}, async () => {
    throw new Error("receipt directory is unreadable");
  });
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
  expect(operations()?.[0]?.state).toBe("pending");
});

test("without a settle check configured, recordUpgrade keeps refusing exactly as before", async () => {
  const { supervisor } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
});

test("an operation moves from pending through its receipt to the server acknowledgement", async () => {
  const { supervisor, operations } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  expect(
    await supervisor.completeUpgrade("a", "request-a", {
      status: "failed",
      error: "candidate failed",
      at: 7,
    }),
  ).toBe(true);
  expect(operations()).toEqual([
    {
      requestId: "request-a",
      expectedVersion: "1.2.3",
      state: "failed",
      requestedAt: NOW,
      terminal: { error: "candidate failed", at: 7 },
    },
  ]);
  // A receipt only ever resolves a pending operation; a late duplicate is ignored.
  expect(await supervisor.completeUpgrade("a", "request-a", { status: "succeeded", at: 8 })).toBe(
    false,
  );

  expect(await supervisor.acknowledgeUpgrade("a", "request-a")).toBe(true);
  expect(operations()?.[0]?.state).toBe("acknowledged");
  // An acknowledged operation no longer blocks the next one.
  expect(await supervisor.recordUpgrade("a", "request-b", "1.2.4")).toBe(true);
});

test("immediately completing a recorded operation as failed (a launch that never started) leaves nothing pending for the next request", async () => {
  const { supervisor, operations } = upgradeFixture();
  await supervisor.recover();

  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3")).toBe(true);
  // Mirrors run-supervisor.ts's `daemon:upgrade` handler: `launchComputerUpgrade` failed, so the
  // operation `recordUpgrade` just opened is settled as failed immediately rather than left
  // "pending" for the full TTL.
  expect(
    await supervisor.completeUpgrade("a", "request-a", {
      status: "failed",
      at: NOW + 1,
      error: "external Computer upgrade coordinator was rejected",
      errorCode: "UPGRADE_LAUNCH_FAILED",
    }),
  ).toBe(true);
  expect(operations()?.[0]).toEqual({
    requestId: "request-a",
    expectedVersion: "1.2.3",
    state: "failed",
    requestedAt: NOW,
    terminal: {
      error: "external Computer upgrade coordinator was rejected",
      errorCode: "UPGRADE_LAUNCH_FAILED",
      at: NOW + 1,
    },
  });
  // Nothing is left pending: a brand-new request is accepted outright, with no settle check
  // configured and no "still pending" refusal.
  expect(await supervisor.recordUpgrade("a", "request-b", "1.2.4")).toBe(true);
});

test("a pending operation cannot be acknowledged and unknown operations are ignored", async () => {
  const { supervisor } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.acknowledgeUpgrade("a", "request-a")).rejects.toThrow(
    "pending Computer upgrade operation cannot be acknowledged",
  );
  expect(await supervisor.acknowledgeUpgrade("a", "absent")).toBe(false);
  expect(await supervisor.completeUpgrade("a", "absent", { status: "succeeded", at: 1 })).toBe(
    false,
  );
});

test("operation history stays capped at the audit tail", async () => {
  const { supervisor, operations } = upgradeFixture({
    upgradeOperations: Array.from({ length: UPGRADE_OPERATION_HISTORY }, (_, index) => ({
      requestId: `old-${index}`,
      expectedVersion: "1.0.0",
      state: "acknowledged" as const,
      requestedAt: NOW - 1,
    })),
  });
  await supervisor.recover();

  await supervisor.recordUpgrade("a", "newest", "1.2.3");

  expect(operations()).toHaveLength(UPGRADE_OPERATION_HISTORY);
  expect(operations()?.at(-1)?.requestId).toBe("newest");
  expect(operations()?.some((entry) => entry.requestId === "old-0")).toBe(false);
});

test("a restart interrupted before OS stop cannot acknowledge replay while the original instance survives", async () => {
  let saved: ManagedBinding[] = [
    { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true },
  ];
  let current: string | null = "original-a";
  let interrupt = true;
  const store = {
    load: async () => structuredClone(saved),
    save: async (bindings: ManagedBinding[]) => {
      saved = structuredClone(bindings);
    },
  };
  const processes = {
    instance: async () => current,
    start: async () => (current ??= "replacement-a"),
    stop: async () => {
      if (interrupt) throw new Error("interrupted before OS stop");
      current = null;
    },
  };
  const original = new MachineSupervisor(store, processes);
  await original.recover();
  await expect(original.command("restart", "a", "request-1")).rejects.toThrow(
    "interrupted before OS stop",
  );
  interrupt = false;
  const recovered = new MachineSupervisor(store, processes);
  await recovered.recover();
  let acknowledged = false;
  try {
    await recovered.command("restart", "a", "request-1");
    acknowledged = true;
  } catch {
    // An explicit unconfirmed outcome is honest; silent success without replacement is not.
  }
  expect(acknowledged && current === "original-a").toBe(false);
});

test("recovery completes a persisted stop without starting it and snapshot drops an exited instance", async () => {
  const running = new Map([
    ["a", "a-live"],
    ["b", "b-live"],
  ]);
  const starts: string[] = [];
  const supervisor = new MachineSupervisor(
    {
      load: async () => [
        { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: false },
        { workspaceId: "b", computerId: "c", workspaceRoot: "/b", enabled: true },
      ],
      save: async () => {},
    },
    {
      start: async (binding) => {
        starts.push(binding.workspaceId);
        return running.get(binding.workspaceId)!;
      },
      stop: async (binding) => {
        running.delete(binding.workspaceId);
      },
      instance: async (binding) => running.get(binding.workspaceId) ?? null,
    },
  );
  await supervisor.recover();
  expect(running.has("a")).toBe(false);
  expect(starts).toEqual(["b"]);
  expect((await supervisor.snapshot())[1]?.instanceId).toBe("b-live");
  running.delete("b");
  expect((await supervisor.snapshot())[1]?.instanceId).toBeNull();
});

test("adding B and restarting A preserves B and a stopped binding across recovery", async () => {
  let saved: ManagedBinding[] = [];
  const running = new Map<string, string>();
  const supervisor = new MachineSupervisor(
    {
      load: async () => saved,
      save: async (bindings) => {
        saved = structuredClone(bindings);
      },
    },
    {
      start: async (binding) => {
        const id = crypto.randomUUID();
        running.set(binding.workspaceId, id);
        return id;
      },
      stop: async (binding) => {
        running.delete(binding.workspaceId);
      },
      instance: async (binding) => running.get(binding.workspaceId) ?? null,
    },
  );
  await supervisor.recover();
  await supervisor.configure({ workspaceId: "a", computerId: "c", workspaceRoot: "/a" });
  const a = running.get("a");
  await supervisor.configure({ workspaceId: "b", computerId: "c", workspaceRoot: "/b" });
  expect(running.get("a")).toBe(a);
  const b = running.get("b");
  await supervisor.command("restart", "a");
  expect(running.get("a")).not.toBe(a);
  expect(running.get("b")).toBe(b);
  await supervisor.command("stop", "b");
  await supervisor.command("restart");
  expect([...running.keys()]).toEqual(["a"]);
  expect(saved.find((binding) => binding.workspaceId === "b")?.enabled).toBe(false);
  await supervisor.shutdown();
  await supervisor.recover();
  expect([...running.keys()]).toEqual(["a"]);
});

test("start retries after readiness fails without retaining a phantom instance", async () => {
  let attempts = 0;
  let current: string | null = null;
  const supervisor = new MachineSupervisor(
    { load: async () => [], save: async () => {} },
    {
      start: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("readiness failed");
        return (current = "second-instance");
      },
      stop: async () => {},
      instance: async () => current,
    },
  );

  await expect(
    supervisor.configure({ workspaceId: "a", computerId: "c", workspaceRoot: "/a" }),
  ).rejects.toThrow("readiness failed");
  await supervisor.command("start", "a");

  expect((await supervisor.snapshot())[0]?.instanceId).toBe("second-instance");
  expect(attempts).toBe(2);
});

test("start replaces an instance that exited outside a lifecycle command", async () => {
  let runningInstance: string | null = null;
  let launches = 0;
  const supervisor = new MachineSupervisor(
    {
      load: async () => [{ workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true }],
      save: async () => {},
    },
    {
      start: async () => (runningInstance = `instance-${++launches}`),
      stop: async () => {
        runningInstance = null;
      },
      instance: async () => runningInstance,
    },
  );
  await supervisor.recover();
  runningInstance = null;

  await supervisor.command("start", "a");

  expect((await supervisor.snapshot())[0]?.instanceId).toBe("instance-2");
});

test.each([
  "before-save-1",
  "after-save-1",
  "before-stop",
  "after-stop",
  "before-save-2",
  "after-save-2",
  "before-spawn",
  "after-spawn",
  "before-save-3",
  "after-save-3",
])(
  "restart recovers cutpoint %s without replacing the replacement or affecting B",
  async (cutpoint) => {
    const fixture = restartFixture();
    let supervisor = fixture.create();
    await supervisor.recover();
    fixture.failAt(cutpoint);
    await expect(supervisor.command("restart", "a", "request")).rejects.toThrow("fault");
    supervisor = fixture.create();
    await supervisor.recover();
    await supervisor.command("restart", "a", "request");
    const replacement = fixture.running.get("a");
    if (!replacement) throw new Error("replacement was not running");
    expect(replacement).not.toBe("old-a");
    expect(fixture.creations).toBe(1);
    expect(fixture.running.get("b")).toBe("old-b");
    await supervisor.command("restart", "a", "request");
    expect(fixture.running.get("a")).toBe(replacement);
    expect((await supervisor.snapshot())[0]?.restartResults).toEqual([
      { requestId: "request", status: "completed", instanceId: replacement },
    ]);
  },
);

test("recovery validates an OS replacement made while a restart was stopping without replacing it again", async () => {
  const fixture = restartFixture();
  const supervisor = fixture.create();
  await supervisor.recover();
  fixture.failAt("before-stop");
  await expect(supervisor.command("restart", "a", "request")).rejects.toThrow("fault");
  fixture.running.set("a", "os-replacement");
  const recovered = fixture.create();
  await recovered.recover();
  await recovered.command("restart", "a", "request");
  expect(fixture.running.get("a")).toBe("os-replacement");
  expect(fixture.running.get("b")).toBe("old-b");
  expect(fixture.creations).toBe(0);
  await recovered.command("stop", "a");
  expect(fixture.running.has("a")).toBe(false);
});

test("stop durably supersedes a pending restart and rejects its later replay", async () => {
  const fixture = restartFixture();
  const supervisor = fixture.create();
  await supervisor.recover();
  fixture.failAt("before-spawn");
  await expect(supervisor.command("restart", "a", "request")).rejects.toThrow("fault");
  await expect(supervisor.command("restart", "a", "different-request")).rejects.toThrow(
    "in progress",
  );
  fixture.failAt("before-stop");
  await expect(supervisor.command("stop", "a")).rejects.toThrow("fault");
  const recovered = fixture.create();
  await recovered.recover();
  expect(fixture.running.has("a")).toBe(false);
  await expect(recovered.command("restart", "a", "request")).rejects.toThrow("cancelled");
  expect(fixture.running.get("b")).toBe("old-b");
  expect((await recovered.snapshot())[0]?.enabled).toBe(false);
});

test.each(["before-save-1", "after-save-1"])(
  "persistence failure %s reloads actual state before the next command",
  async (cutpoint) => {
    const fixture = restartFixture();
    const supervisor = fixture.create();
    await supervisor.recover();
    fixture.failAt(cutpoint);
    await expect(supervisor.command("stop", "a")).rejects.toThrow("fault");
    expect((await supervisor.snapshot())[0]?.enabled).toBe(cutpoint === "before-save-1");
    expect(fixture.running.get("a")).toBe("old-a");
    await supervisor.command("stop", "a");
    expect(fixture.running.has("a")).toBe(false);
  },
);

test("failed A recovery still reconciles B and leaves stop available", async () => {
  const fixture = restartFixture();
  const supervisor = fixture.create();
  await supervisor.recover();
  fixture.failAt("before-stop");
  await expect(supervisor.command("restart", "a", "request")).rejects.toThrow();
  fixture.running.delete("b");
  fixture.failAt("before-stop");
  const recovered = fixture.create();
  await expect(recovered.recover()).rejects.toThrow("recovery incomplete");
  expect(fixture.running.has("b")).toBe(true);
  await recovered.command("stop", "a");
  expect(fixture.running.has("a")).toBe(false);
});

test("failed OS stop reports persisted disabled intent alongside the still-live instance", async () => {
  const fixture = restartFixture();
  const supervisor = fixture.create();
  await supervisor.recover();
  fixture.failAt("before-stop");
  await expect(supervisor.command("stop", "a")).rejects.toThrow("fault");
  expect(
    (await supervisor.snapshot()).find((binding) => binding.workspaceId === "a"),
  ).toMatchObject({ enabled: false, instanceId: "old-a" });
  await fixture.create().recover();
  expect(fixture.running.has("a")).toBe(false);
  expect(fixture.running.get("b")).toBe("old-b");
});

function restartFixture() {
  let saved: ManagedBinding[] = ["a", "b"].map((workspaceId) => ({
    workspaceId,
    computerId: "c",
    workspaceRoot: `/${workspaceId}`,
    enabled: true,
  }));
  const running = new Map<string, string>([
    ["a", "old-a"],
    ["b", "old-b"],
  ]);
  let fault: string | undefined;
  let saves = 0;
  let creations = 0;
  const hit = (point: string) => {
    if (fault !== point) return;
    fault = undefined;
    throw new Error(`fault at ${point}`);
  };
  return {
    running,
    get creations() {
      return creations;
    },
    failAt(point: string) {
      fault = point;
      saves = 0;
    },
    create: () =>
      new MachineSupervisor(
        {
          load: async () => structuredClone(saved),
          async save(bindings) {
            const number = ++saves;
            hit(`before-save-${number}`);
            saved = structuredClone(bindings);
            hit(`after-save-${number}`);
          },
        },
        {
          instance: async (binding) => running.get(binding.workspaceId) ?? null,
          async start(binding) {
            if (!running.has(binding.workspaceId)) {
              hit("before-spawn");
              running.set(binding.workspaceId, `new-${++creations}`);
              hit("after-spawn");
            }
            return running.get(binding.workspaceId)!;
          },
          async stop(binding) {
            hit("before-stop");
            running.delete(binding.workspaceId);
            hit("after-stop");
          },
        },
      ),
  };
}

test("an explicit start clears the Workspace's health latch before starting it", async () => {
  const cleared: string[] = [];
  const running = new Map<string, string>();
  const supervisor = new MachineSupervisor(
    {
      load: async () => [
        { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: false },
      ],
      save: async () => {},
    },
    {
      start: async (binding) => {
        const id = crypto.randomUUID();
        running.set(binding.workspaceId, id);
        return id;
      },
      stop: async (binding) => {
        running.delete(binding.workspaceId);
      },
      instance: async (binding) => running.get(binding.workspaceId) ?? null,
      clearHealth: async (binding) => {
        cleared.push(binding.workspaceId);
      },
    },
  );
  await supervisor.recover();

  await supervisor.command("start", "a");

  expect(cleared).toEqual(["a"]);
});

test("an explicit restart clears the Workspace's health latch before starting the replacement", async () => {
  const cleared: string[] = [];
  const running = new Map<string, string>();
  const supervisor = new MachineSupervisor(
    {
      load: async () => [{ workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true }],
      save: async () => {},
    },
    {
      start: async (binding) => {
        const id = crypto.randomUUID();
        running.set(binding.workspaceId, id);
        return id;
      },
      stop: async (binding) => {
        running.delete(binding.workspaceId);
      },
      instance: async (binding) => running.get(binding.workspaceId) ?? null,
      clearHealth: async (binding) => {
        cleared.push(binding.workspaceId);
      },
    },
  );
  await supervisor.recover();
  cleared.length = 0;

  await supervisor.command("restart", "a", "request-1");

  expect(cleared).toEqual(["a"]);
});

test("stop never clears the Workspace's health latch", async () => {
  const cleared: string[] = [];
  const supervisor = new MachineSupervisor(
    {
      load: async () => [{ workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true }],
      save: async () => {},
    },
    {
      start: async () => "instance",
      stop: async () => {},
      instance: async () => "instance",
      clearHealth: async (binding) => {
        cleared.push(binding.workspaceId);
      },
    },
  );
  await supervisor.recover();
  cleared.length = 0;

  await supervisor.command("stop", "a");

  expect(cleared).toEqual([]);
});

test("automatic recovery on Coordinator startup never clears a Workspace's health latch", async () => {
  const cleared: string[] = [];
  const supervisor = new MachineSupervisor(
    {
      load: async () => [{ workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true }],
      save: async () => {},
    },
    {
      start: async () => "instance",
      stop: async () => {},
      instance: async () => null,
      clearHealth: async (binding) => {
        cleared.push(binding.workspaceId);
      },
    },
  );

  await supervisor.recover();

  expect(cleared).toEqual([]);
});
