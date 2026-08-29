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

test("Windows launch fails closed until complete tree ownership is available", () => {
  const owner = new ProcessTreeOwner("win32");
  expect(() =>
    owner.spawn([globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    }),
  ).toThrow("Windows Agent process isolation is unavailable");
});
