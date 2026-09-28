import { expect, test } from "bun:test";
import type { HeldBusyAgent } from "@lrm/coforge-sdk/internal";
import { MachineSupervisor, type ManagedBinding } from "#src/supervisor/machine-supervisor";
import type { RunnerHoldSnapshot } from "#src/supervisor/runner-hold";

/** A virtual clock: `sleep` advances `now` instantly, so the bound costs no wall time. */
function clock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

const busy = (agentId: string): HeldBusyAgent => ({
  workspaceId: "a",
  agentId,
  detailKind: "tool_started",
  busySinceMs: 0,
});
const idle: RunnerHoldSnapshot = { busyAgents: [], unreachableWorkspaceIds: [] };

type Hold = (binding: ManagedBinding, reason: string) => Promise<RunnerHoldSnapshot>;

/**
 * Workspaces that are live when the fixture is built. `calls` records what the restart hold is
 * about: every `hold` and `stop` the supervisor performed, in order.
 */
function holdFixture(options: {
  hold?: Hold;
  /** Makes the OS stop fail, to prove the hold is lifted on a daemon that survived it. */
  stopFails?: boolean;
  bindings?: ManagedBinding[];
  live?: [string, string][];
}) {
  let saved = structuredClone(
    options.bindings ?? [
      { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true } as ManagedBinding,
    ],
  );
  const running = new Map<string, string>(options.live ?? [["a", "old-a"]]);
  const calls: string[] = [];
  // A poll re-asks the same hold; record only the first ask per Workspace so `calls` stays a
  // statement about ordering rather than about poll count.
  const held = new Set<string>();
  const time = clock();
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(saved),
      save: async (bindings) => {
        saved = structuredClone(bindings);
      },
    },
    {
      instance: async (binding) => running.get(binding.workspaceId) ?? null,
      // Adoption-aware, like the OS units are: a live invocation is reported, not replaced.
      start: async (binding) => {
        if (!running.has(binding.workspaceId))
          running.set(binding.workspaceId, `new-${binding.workspaceId}`);
        return running.get(binding.workspaceId)!;
      },
      stop: async (binding) => {
        calls.push(`stop:${binding.workspaceId}`);
        if (options.stopFails) throw new Error("launchctl bootout failed");
        running.delete(binding.workspaceId);
      },
      release: async (binding: ManagedBinding, reason: string) => {
        calls.push(`release:${binding.workspaceId}:${reason}`);
      },
      ...(options.hold
        ? {
            hold: (binding: ManagedBinding, reason: string) => {
              if (!held.has(binding.workspaceId)) {
                held.add(binding.workspaceId);
                calls.push(`hold:${binding.workspaceId}:${reason}`);
              }
              return options.hold!(binding, reason);
            },
          }
        : {}),
    },
    undefined,
    // A short bound on a virtual clock; the real 30s budget is covered by the quiescence tests.
    { holdMs: 1_000, pollMs: 250, ...time },
  );
  return { supervisor, running, calls };
}

test("a restart holds a live Workspace's runners before stopping it", async () => {
  const fixture = holdFixture({ hold: async () => idle });
  await fixture.supervisor.recover();

  await fixture.supervisor.command("restart", "a", "request");

  expect(fixture.calls).toEqual(["hold:a:restart", "stop:a"]);
  expect(fixture.running.get("a")).toBe("new-a");
});

test("a restart stops anyway when the Agents are still busy at the deadline", async () => {
  let asked = 0;
  const fixture = holdFixture({
    hold: async () => {
      asked += 1;
      return { busyAgents: [busy("agent-a")], unreachableWorkspaceIds: [] };
    },
  });
  await fixture.supervisor.recover();

  await fixture.supervisor.command("restart", "a", "request");

  // Polled to the bound rather than giving up after one look, then stopped regardless.
  expect(asked).toBeGreaterThan(1);
  expect(fixture.calls).toEqual(["hold:a:restart", "stop:a"]);
  expect(fixture.running.get("a")).toBe("new-a");
});

test.each([
  ["throws", (async () => Promise.reject(new Error("Workspace socket is gone"))) as Hold],
  [
    "reports its Workspace unreachable",
    (async () => ({ busyAgents: [], unreachableWorkspaceIds: ["a"] })) as Hold,
  ],
  [
    "never goes quiet and cannot be re-asked",
    (() => {
      let calls = 0;
      return (async () => {
        calls += 1;
        if (calls === 1) return { busyAgents: [busy("agent-a")], unreachableWorkspaceIds: [] };
        throw new Error("Workspace went away mid-hold");
      }) as Hold;
    })(),
  ],
])("a hold that %s still restarts the Workspace", async (_label, hold) => {
  const fixture = holdFixture({ hold });
  await fixture.supervisor.recover();

  await fixture.supervisor.command("restart", "a", "request");

  expect(fixture.calls).toEqual(["hold:a:restart", "stop:a"]);
  expect(fixture.running.get("a")).toBe("new-a");
});

test("a restart of an already-dead instance has nothing to hold", async () => {
  const fixture = holdFixture({ hold: async () => idle });
  await fixture.supervisor.recover();
  // The Workspace daemon exited outside a lifecycle command; there is nothing left to drain.
  fixture.running.delete("a");

  await fixture.supervisor.command("restart", "a", "request");

  expect(fixture.calls).toEqual(["stop:a"]);
  expect(fixture.running.get("a")).toBe("new-a");
});

test("a restart resumed after the OS already replaced the instance neither holds nor stops", async () => {
  const fixture = holdFixture({
    hold: async () => idle,
    bindings: [
      {
        workspaceId: "a",
        computerId: "c",
        workspaceRoot: "/a",
        enabled: true,
        restart: { requestId: "request", phase: "stopping", previousInstanceId: "old-a" },
      },
    ],
    live: [["a", "os-replacement"]],
  });

  await fixture.supervisor.recover();

  expect(fixture.calls).toEqual([]);
  expect(fixture.running.get("a")).toBe("os-replacement");
});

test("stop never holds; an explicit stop is an operator saying now", async () => {
  const fixture = holdFixture({ hold: async () => idle });
  await fixture.supervisor.recover();

  await fixture.supervisor.command("stop", "a");

  expect(fixture.calls).toEqual(["stop:a"]);
  expect(fixture.running.has("a")).toBe(false);
});

test("a WorkspaceProcesses without a hold restarts with the previous behaviour", async () => {
  const fixture = holdFixture({});
  await fixture.supervisor.recover();

  await fixture.supervisor.command("restart", "a", "request");

  expect(fixture.calls).toEqual(["stop:a"]);
  expect(fixture.running.get("a")).toBe("new-a");
});

test("an unscoped restart holds each enabled binding as the loop reaches it", async () => {
  const fixture = holdFixture({
    hold: async () => idle,
    bindings: ["a", "b"].map((workspaceId) => ({
      workspaceId,
      computerId: "c",
      workspaceRoot: `/${workspaceId}`,
      enabled: true,
    })),
    live: [
      ["a", "old-a"],
      ["b", "old-b"],
    ],
  });
  await fixture.supervisor.recover();

  await fixture.supervisor.command("restart");

  expect(fixture.calls).toEqual(["hold:a:restart", "stop:a", "hold:b:restart", "stop:b"]);
});

test("a stop that fails after the hold releases the surviving daemon before rethrowing", async () => {
  const fixture = holdFixture({ hold: async () => idle, stopFails: true });
  await fixture.supervisor.recover();
  await expect(fixture.supervisor.command("restart", "a")).rejects.toThrow(
    "launchctl bootout failed",
  );
  expect(fixture.calls).toEqual(["hold:a:restart", "stop:a", "release:a:restart"]);
});
