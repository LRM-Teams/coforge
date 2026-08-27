import { dirname } from "node:path";
import { expect, test } from "bun:test";

import { bunExecutable, pathWithBun } from "../scripts/local-bun";

test("pathWithBun puts the running bun ahead of a PATH that does not include it", () => {
  const bunDir = dirname(process.execPath);
  const path = pathWithBun({ PATH: "/usr/bin:/bin" });
  expect(path.startsWith(`${bunDir}:`)).toBe(true);
  expect(bunExecutable()).toBe(process.execPath);
});

test("a bun child starts when PATH does not contain bun", async () => {
  const child = Bun.spawn([bunExecutable(), "--version"], {
    env: {
      HOME: process.env.HOME,
      PATH: pathWithBun({ PATH: "/usr/bin:/bin" }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain("1.");
});
