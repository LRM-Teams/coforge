import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The rename script refuses a run that could change data by accident before it reads a database:
 * every case here exits on its arguments, so none needs (or reaches) a `DATABASE_URL`. The runs
 * against a database are in `username-rename.integration.test.ts`.
 */
const webRoot = join(import.meta.dir, "..");
const script = join(webRoot, "scripts/rename-usernames.ts");

async function run(...args: string[]) {
  return runWith({}, ...args);
}

async function runWith(environment: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn(["bun", "run", script, ...args], {
    cwd: webRoot,
    env: { ...process.env, ...environment },
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

test("--apply without a dump file is refused, and says what to add", async () => {
  const result = await run("--apply");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("--apply needs --dump <file>");
  expect(result.stdout).toBe("");
});

test("--dump without --apply is refused, since only an apply writes one", async () => {
  const result = await run("--dump", "dump.json");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("--dump goes with --apply");
});

test("only one of --apply, --verify and --restore is accepted", async () => {
  for (const args of [
    ["--apply", "--dump", "dump.json", "--verify"],
    ["--verify", "--restore", "dump.json"],
    ["--apply", "--dump", "dump.json", "--restore", "dump.json"],
  ]) {
    const result = await run(...args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("only one of --apply, --verify and --restore");
  }
});

test("an unknown option or a missing file name is a usage error, not a run", async () => {
  for (const args of [["--everything"], ["--restore"], ["stray"]]) {
    const result = await run(...args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage:");
  }
});

test("a DATABASE_URL that cannot be read is called that, never echoed, and nothing is done", async () => {
  for (const url of ["not a url zq7Xk", "postgresql://coforge:12345/zq7Xk@db.internal/coforge"]) {
    const result = await runWith({ DATABASE_URL: url }, "--verify");

    expect(result.exitCode).toBe(1);
    expect(result.stdout.split("\n")[0]).toBe("database: (unparseable URL)");
    expect(result.stdout + result.stderr).not.toContain("zq7Xk");
    expect(result.stdout + result.stderr).not.toContain("12345");
  }
});
