import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "..", "src", "release", "upgrade-runner.ts");

test("every upgrade path is resolved from the same home directory as the Coordinator state", () => {
  // Without HOME, os.homedir() falls back to the account's own home directory; a separate
  // HOME/USERPROFILE read would instead put the installation somewhere else entirely.
  const { HOME: _home, ...environment } = Bun.env;
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { resolveUpgradeCoordinatorPaths } = await import(${JSON.stringify(runner)});
       const { homedir } = await import("node:os");
       console.log(JSON.stringify({ home: homedir(), paths: resolveUpgradeCoordinatorPaths() }));`,
    ],
    env: { ...environment, USERPROFILE: "/not/the/home/directory", XDG_BIN_HOME: "" },
  });
  expect(child.stderr.toString()).toBe("");
  const { home, paths } = JSON.parse(child.stdout.toString());
  expect(home).toBe(homedir());
  expect(paths.supervisorStatePath).toBe(join(home, ".coforge", "daemon"));
  expect(paths.installRoot).toBe(join(home, ".coforge", "computer", "install"));
  expect(paths.binaryDirectory).toBe(
    process.platform === "win32"
      ? join(home, ".coforge", "computer", "bin")
      : join(home, ".local", "bin"),
  );
});
