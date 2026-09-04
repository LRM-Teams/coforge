import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

import { JsonlProcess } from "../src/code-agent/jsonl-process";
import type { OwnedProcessTree } from "../src/platform/process-tree";
import { ProcessTreeOwner } from "../src/platform/process-tree";
import { AgentProcessManager } from "../src/agent-runtime/agent-process-manager";
import type { AgentSession } from "@coforge/agent";

test("send waits for stdin drain after a backpressured write", async () => {
  let releaseDrain!: () => void;
  const drain = new Promise<void>((resolve) => (releaseDrain = resolve));
  const never = new Promise<number>(() => undefined);
  const tree = {
    child: {
      pid: 1,
      exited: never,
      exitCode: null,
      stdin: { write: () => false, end: () => undefined, flush: () => drain },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
  const process = new JsonlProcess(
    ["unused"],
    tmpdir(),
    {},
    {
      spawn: () => tree,
    },
  );

  let completed = false;
  const sending = process.send({ method: "backpressure" }).then(() => (completed = true));
  await Promise.resolve();
  expect(completed).toBe(false);
  releaseDrain();
  await sending;
  expect(completed).toBe(true);
});

test("invalid child output permanently fails current and future requests", async () => {
  const child = new JsonlProcess(
    [globalThis.process.execPath, new URL("./fixtures/invalid-jsonl.ts", import.meta.url).pathname],
    tmpdir(),
    { PATH: globalThis.process.env.PATH ?? "" },
  );

  try {
    await Bun.sleep(20);
    await expect(child.request({ method: "after-invalid-output" })).rejects.toThrow(
      "invalid output",
    );
    await expect(child.request({ method: "still-failed" })).rejects.toThrow("invalid output");
  } finally {
    await child.dispose();
  }
});

test("startup spawn failure permits the manager to retry", async () => {
  let starts = 0;
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      starts++;
      return sessionFor(
        new JsonlProcess([`coforge-missing-${crypto.randomUUID()}`], tmpdir(), {
          PATH: globalThis.process.env.PATH ?? "",
        }),
      );
    },
  }));
  const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
  const workspace = `${tmpdir()}/coforge-startup-failure-${crypto.randomUUID()}`;

  await expect(manager.start("agent-1", runtime, workspace)).rejects.toThrow(
    "Executable not found",
  );
  expect(manager.size).toBe(0);

  await expect(manager.start("agent-1", runtime, workspace)).rejects.toThrow(
    "Executable not found",
  );
  expect(starts).toBe(2);
});

test("startup cleanup probe failure blocks a replacement", async () => {
  const tree = {
    child: {
      pid: 1,
      exited: Promise.resolve(1),
      exitCode: 1,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => {
      throw new Error("process inspection unavailable");
    },
  } satisfies OwnedProcessTree;
  let starts = 0;
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      starts++;
      const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
      await process.dispose();
      return sessionFor(process);
    },
  }));
  const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
  const workspace = `${tmpdir()}/coforge-startup-probe-${crypto.randomUUID()}`;

  await expect(manager.start("agent-1", runtime, workspace)).rejects.toThrow(
    "process tree did not exit",
  );
  await expect(manager.start("agent-1", runtime, workspace)).rejects.toThrow("stopping");
  expect(starts).toBe(1);
});

test.skipIf(process.platform === "win32")(
  "dispose terminates and reaps a direct process with long-lived descendants",
  async () => {
    const owner = new ProcessTreeOwner();
    let directExited: Promise<number> | undefined;
    const process = new JsonlProcess(
      [globalThis.process.execPath, `${import.meta.dir}/fixtures/process-tree.ts`],
      import.meta.dir,
      Object.fromEntries(
        Object.entries(globalThis.process.env).filter((entry): entry is [string, string] =>
          Boolean(entry[1]),
        ),
      ),
      {
        spawn(command, cwd, environment) {
          const tree = owner.spawn(command, cwd, environment);
          directExited = tree.child.exited;
          return tree;
        },
      } as ProcessTreeOwner,
    );
    const observedPids = new Promise<{ childPid: number; grandchildPid: number }>((resolve) => {
      process.onRecord((record) => resolve(record as { childPid: number; grandchildPid: number }));
    });
    const { childPid, grandchildPid } = await observedPids;
    try {
      await process.dispose();
      expect(await directExited).toBeNumber();
      expect(pidExists(childPid)).toBe(false);
      expect(pidExists(grandchildPid)).toBe(false);
    } finally {
      killIfPresent(childPid);
      killIfPresent(grandchildPid);
      await process.dispose();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "unexpected direct exit closes only after descendants exit and then permits replacement",
  async () => {
    const environment = Object.fromEntries(
      Object.entries(globalThis.process.env).filter((entry): entry is [string, string] =>
        Boolean(entry[1]),
      ),
    );
    let starts = 0;
    let pids: { childPid: number; grandchildPid: number } | undefined;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        starts++;
        const process = new JsonlProcess(
          [globalThis.process.execPath, `${import.meta.dir}/fixtures/process-tree.ts`],
          import.meta.dir,
          { ...environment, EXIT_DIRECT: "1" },
        );
        process.onRecord((record) => (pids = record as typeof pids));
        return sessionFor(process);
      },
    }));
    const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
    const workspace = `${tmpdir()}/coforge-unexpected-exit-${crypto.randomUUID()}`;

    await manager.start("agent-1", runtime, workspace);
    await waitUntil(() => pids !== undefined);
    await waitUntil(() => manager.session("agent-1") === undefined);
    expect(manager.status("agent-1")).toBe("active");
    expect(pidExists(pids!.childPid)).toBe(false);
    expect(pidExists(pids!.grandchildPid)).toBe(false);
    await manager.start("agent-1", runtime, workspace);
    expect(starts).toBe(2);
    await manager.shutdown();
  },
  10_000,
);

test("failed unexpected-exit tree cleanup does not close or permit replacement", async () => {
  const exited = Promise.resolve(17);
  let failures = 0;
  let closes = 0;
  const tree = {
    child: {
      pid: 1,
      exited,
      exitCode: 17,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => false,
  } satisfies OwnedProcessTree;
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
  process.onFailure(() => failures++);
  process.onClose(() => closes++);
  let starts = 0;
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      starts++;
      return sessionFor(process);
    },
  }));
  const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
  const workspace = `${tmpdir()}/coforge-failed-cleanup-${crypto.randomUUID()}`;

  await manager.start("agent-1", runtime, workspace);
  await waitUntil(() => failures > 0);
  expect(closes).toBe(0);
  await expect(manager.start("agent-1", runtime, workspace)).rejects.toThrow("active");
  expect(starts).toBe(1);
  expect(manager.status("agent-1")).toBe("active");
});

function sessionFor(process: JsonlProcess): AgentSession {
  return {
    sendMessage: async (message) => process.send({ message }),
    subscribe: () => () => undefined,
    interrupt: async () => process.interrupt(),
    onExit: (listener) => process.onClose(listener),
    dispose: () => process.dispose(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition was not met");
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    throw error;
  }
}

function killIfPresent(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") throw error;
  }
}
