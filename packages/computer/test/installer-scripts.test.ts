import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

test("install.sh forwards latest, test, and exact selectors to the verified bootstrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const bootstrap = join(directory, "bootstrap");
  await writeFile(bootstrap, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
  await chmod(bootstrap, 0o700);
  const script = resolve(import.meta.dir, "../../../install.sh");

  for (const selector of [
    "latest",
    "test",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ]) {
    const child = Bun.spawnSync({
      cmd: [script, "--version", selector],
      env: { ...process.env, COFORGE_INSTALLER_TEST_MODE: "1", COFORGE_BOOTSTRAP_PATH: bootstrap },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "install",
      "--version",
      selector,
    ]);
  }

  const omitted = Bun.spawnSync({
    cmd: [script],
    env: {
      ...process.env,
      COFORGE_INSTALLER_TEST_MODE: "1",
      COFORGE_BOOTSTRAP_PATH: bootstrap,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(omitted.exitCode).toBe(0);
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
    "install",
    "--version",
    "latest",
  ]);
});

test("install scripts fail closed before using an invalid or unpublished selector", async () => {
  const shell = await readFile(resolve(import.meta.dir, "../../../install.sh"), "utf8");
  const powershell = await readFile(resolve(import.meta.dir, "../../../install.ps1"), "utf8");

  expect(shell).not.toContain("sudo");
  expect(shell).not.toContain("/usr/local");
  expect(powershell).not.toContain("Program Files");
  expect(powershell).not.toContain("Start-Process -Verb RunAs");
  expect(shell).toContain("OSS/CDN provisioning is pending");
  expect(powershell).toContain("OSS/CDN provisioning is pending");
});
