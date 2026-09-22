import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { ProcessTreeOwner } from "../src/platform/process-tree";

test("spawn errors without an OS process fail synchronously", () => {
  const owner = new ProcessTreeOwner();
  expect(() =>
    owner.spawn([`coforge-missing-${crypto.randomUUID()}`], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    }),
  ).toThrow("Executable not found");
});

test("Windows launch fails closed when Job Object creation is unavailable", () => {
  const owner = new ProcessTreeOwner("win32", undefined, {
    createJobObject: () => {
      throw new Error("no job objects in this test");
    },
  });
  expect(() =>
    owner.spawn([globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    }),
  ).toThrow("Windows Agent process isolation is unavailable");
});

test.skipIf(process.platform !== "win32")(
  "Windows Job Object terminate clears a live Agent child",
  async () => {
    const owner = new ProcessTreeOwner();
    const tree = owner.spawn(
      [globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"],
      tmpdir(),
      { PATH: globalThis.process.env.PATH ?? "" },
    );
    expect(tree.child.pid).toBeGreaterThan(0);
    await tree.terminate(true);
    expect(await tree.waitForExit(2_000)).toBe(true);
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows Job Object terminate clears a child that spawned a grandchild",
  async () => {
    const owner = new ProcessTreeOwner();
    const script = `
      Bun.spawn({
        cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      setInterval(() => {}, 1000);
    `;
    const tree = owner.spawn([globalThis.process.execPath, "-e", script], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    });
    await Bun.sleep(300);
    await tree.terminate(true);
    expect(await tree.waitForExit(3_000)).toBe(true);
  },
);

/** Blocks the event loop so an exited child stays unreaped. `Bun.sleep` yields instead, which lets
 * the runtime reap the zombie before the test can observe it. */
function blockEventLoop(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // Deliberate synchronous wait.
  }
}

test("a group whose only remaining member is a zombie counts as exited", async () => {
  const owner = new ProcessTreeOwner();
  const tree = owner.spawn([globalThis.process.execPath, "-e", "process.exit(0)"], tmpdir(), {
    PATH: globalThis.process.env.PATH ?? "",
  });
  // The child has exited but is still unreaped, so the group's only member is a zombie. macOS
  // answers EPERM - not ESRCH - for both `kill(-pgid, 0)` and `kill(-pgid, SIGKILL)` in exactly
  // that state, which used to surface as a thrown cleanup failure. The linux branch already
  // ignores zombies explicitly.
  blockEventLoop(300);
  expect(await tree.waitForExit(1_000)).toBe(true);
  await tree.terminate(true);
});
