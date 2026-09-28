import { beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetGitHookVersionProbeCacheForTests,
  resolveGitHookInjectionForLaunch,
} from "#src/code-agent/git-hooks";
import { resetGitHookShimDirectoryCacheForTests } from "#src/code-agent/git-hook-shims";

async function fakeGit(version: string | undefined): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-fake-git-"));
  const path = join(directory, "git");
  const body =
    version === undefined
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nexit 1\n`;
  await writeFile(path, body);
  await chmod(path, 0o755);
  return directory;
}

beforeEach(() => {
  resetGitHookVersionProbeCacheForTests();
  resetGitHookShimDirectoryCacheForTests();
});

test("git missing from PATH injects nothing", async () => {
  const plan = await resolveGitHookInjectionForLaunch("/nonexistent-coforge-test-path");
  expect(plan).toBeUndefined();
});

test("an unparseable git --version injects nothing", async () => {
  const gitDirectory = await fakeGit("garbage output, not a version string");
  expect(await resolveGitHookInjectionForLaunch(gitDirectory)).toBeUndefined();
});

test("a git that exits non-zero on --version injects nothing", async () => {
  const gitDirectory = await fakeGit(undefined);
  expect(await resolveGitHookInjectionForLaunch(gitDirectory)).toBeUndefined();
});

test("git >= 2.54 resolves the config-hook plan", async () => {
  for (const version of ["2.54.0", "2.54.1", "3.0.0", "2.60"]) {
    const gitDirectory = await fakeGit(version);
    expect(await resolveGitHookInjectionForLaunch(gitDirectory)).toEqual({ kind: "config-hook" });
  }
});

test("git < 2.54 resolves the hooks-path plan when the shim directory can be prepared", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "coforge-daemon-home-"));
  const previous = process.env.COFORGE_DAEMON_HOME;
  process.env.COFORGE_DAEMON_HOME = daemonHome;
  try {
    for (const version of ["2.43.0", "1.8.5", "2.53.9"]) {
      resetGitHookVersionProbeCacheForTests();
      const gitDirectory = await fakeGit(version);
      const plan = await resolveGitHookInjectionForLaunch(gitDirectory);
      expect(plan?.kind).toBe("hooks-path");
    }
  } finally {
    if (previous === undefined) delete process.env.COFORGE_DAEMON_HOME;
    else process.env.COFORGE_DAEMON_HOME = previous;
    resetGitHookVersionProbeCacheForTests();
    resetGitHookShimDirectoryCacheForTests();
  }
});

test("a pre-2.54 git on win32 injects nothing (the shim directory holds POSIX sh, not usable there)", async () => {
  const gitDirectory = await fakeGit("2.43.0");
  expect(await resolveGitHookInjectionForLaunch(gitDirectory, "win32")).toBeUndefined();
});

test("the version probe is cached per resolved git executable path", async () => {
  const gitDirectory = await fakeGit("2.54.0");
  expect(await resolveGitHookInjectionForLaunch(gitDirectory)).toEqual({ kind: "config-hook" });
  const gitPath = join(gitDirectory, "git");
  // Replace the fake git with one that would answer differently, without invalidating the cache:
  // a second probe on the same resolved path must reuse the first answer rather than re-spawn.
  await writeFile(gitPath, '#!/bin/sh\necho "git version 2.40.0"\nexit 0\n');
  await chmod(gitPath, 0o755);
  expect(await resolveGitHookInjectionForLaunch(gitDirectory)).toEqual({ kind: "config-hook" });
});
