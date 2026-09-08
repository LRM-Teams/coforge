import { expect, test } from "bun:test";
import { MachineSupervisor, type ManagedBinding } from "../src/supervisor/machine-supervisor";

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
