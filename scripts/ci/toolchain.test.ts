import { expect, test } from "bun:test";

const config = Bun.TOML.parse(await Bun.file("mise.toml").text());
const lockfile = Bun.TOML.parse(await Bun.file("mise.lock").text());

/** Amp runs these before a thread starts. `set -euo pipefail` means a task name that no
 * longer exists aborts the whole script instead of failing one step. */
const AGENT_SETUP_SCRIPTS = [".agents/setup", ".agents/resume"];

/** `mise install --locked` fails outright when a declared tool has no locked URL for the
 * current platform. `mise lock` reuses the platforms already in the lockfile, so a lockfile
 * regenerated on Linux keeps omitting macOS even though macOS is a documented local
 * development platform and `scripts/release/compile-targets.ts` ships both darwin targets. */
const REQUIRED_LOCKFILE_PLATFORMS = ["macos-arm64", "macos-x64"];

function lockedPlatforms(tool: string): Set<string> {
  const platforms = new Set<string>();
  for (const entry of lockfile.tools?.[tool] ?? []) {
    for (const [key, value] of Object.entries(entry)) {
      if (key.startsWith("platforms.") && value?.url) platforms.add(key.slice(10));
    }
  }
  return platforms;
}

test("the agent setup scripts only invoke mise tasks that exist", async () => {
  const tasks = new Set(Object.keys(config.tasks ?? {}));
  let invocations = 0;
  for (const path of AGENT_SETUP_SCRIPTS) {
    const script = await Bun.file(path).text();
    for (const [, task] of script.matchAll(/\bmise(?:_bin)?"?\s+run\s+([\w:.-]+)/g)) {
      invocations += 1;
      expect(tasks.has(task), `${path} invokes an undeclared mise task: ${task}`).toBe(true);
    }
  }
  expect(invocations).toBeGreaterThan(0);
});

test("every declared tool is locked for each required platform", () => {
  const tools = Object.keys(config.tools ?? {});
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) {
    const platforms = lockedPlatforms(tool);
    for (const platform of REQUIRED_LOCKFILE_PLATFORMS) {
      expect(platforms.has(platform), `mise.lock has no ${platform} URL for ${tool}`).toBe(true);
    }
  }
});

test("the lockfile pins no tool that mise.toml has dropped", () => {
  const declared = new Set(Object.keys(config.tools ?? {}));
  for (const tool of Object.keys(lockfile.tools ?? {})) {
    expect(declared.has(tool), `mise.lock still pins the removed tool: ${tool}`).toBe(true);
  }
});
