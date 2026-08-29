import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { ProcessTreeOwner } from "../src/platform/process-tree";

test("spawn errors without an OS process need no tree termination", async () => {
  const owner = new ProcessTreeOwner();
  const tree = owner.spawn([`coforge-missing-${crypto.randomUUID()}`], tmpdir(), {
    PATH: globalThis.process.env.PATH ?? "",
  });

  expect(tree.child.pid).toBeUndefined();
  await tree.terminate(false);
  expect(await tree.waitForExit(0)).toBe(true);
  expect(await tree.child.exited).not.toBe(0);
});

test("Windows launch fails closed until complete tree ownership is available", () => {
  const owner = new ProcessTreeOwner("win32");
  expect(() =>
    owner.spawn([globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    }),
  ).toThrow("Windows Agent process isolation is unavailable");
});
