import { join } from "node:path";
import { expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "../../..");
const helper = join(repoRoot, "scripts/lib/local-web.sh");

async function sh(script: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(["sh", "-c", script], {
    cwd: repoRoot,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("prepare_local_web_runtime finds bun when PATH does not include it", async () => {
  const result = await sh(
    `. "${helper}" && prepare_local_web_runtime test && command -v bun && bun --version`,
    { PATH: "/usr/bin:/bin" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1.");
});

test("replace_listener_on_port stops the process holding that port", async () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("probe");
    },
  });
  const port = probe.port;
  await probe.stop(true);

  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch() { return new Response("old"); } });`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  await Bun.sleep(150);
  const before = await Bun.fetch(`http://127.0.0.1:${port}/`);
  expect(before.status).toBe(200);
  expect(await before.text()).toBe("old");

  const result = await sh(`. "${helper}" && replace_listener_on_port test ${port}`);
  expect(result.exitCode).toBe(0);
  expect(await holder.exited).not.toBe(null);

  const replacement = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch() {
      return new Response("new");
    },
  });
  const after = await Bun.fetch(`http://127.0.0.1:${port}/`);
  expect(await after.text()).toBe("new");
  await replacement.stop(true);
});
