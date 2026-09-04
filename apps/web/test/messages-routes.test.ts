import { expect, test } from "bun:test";

test("messages routes work in an isolated Bun test process", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", "./test/fixtures/messages-routes.fixture.tsx"],
    {
      cwd: import.meta.dir.replace(/\/test$/, ""),
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = `${stdout}\n${stderr}`;

  expect(output).not.toMatch(/HTML nesting|ECONNREFUSED|NetworkError|\[object Object\]/);
  expect(exitCode, output).toBe(0);
  expect(output).toContain("5 pass");
});
