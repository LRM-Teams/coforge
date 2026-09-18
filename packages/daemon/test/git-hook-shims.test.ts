import { beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_HOOK_SHIM_NAMES,
  ensureGitHookShimDirectory,
  gitHookShimScript,
  resetGitHookShimDirectoryCacheForTests,
} from "../src/code-agent/git-hook-shims";

beforeEach(() => {
  resetGitHookShimDirectoryCacheForTests();
});

test("gitHookShimScript runs the CoForge commit trailer command only for prepare-commit-msg", () => {
  expect(gitHookShimScript("prepare-commit-msg")).toContain("coforge git prepare-commit-msg");
  for (const name of GIT_HOOK_SHIM_NAMES) {
    if (name === "prepare-commit-msg") continue;
    expect(gitHookShimScript(name)).not.toContain("coforge git prepare-commit-msg");
  }
});

test("ensureGitHookShimDirectory writes an executable shim for every hook name, mode 0700, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-shim-root-"));
  const directory = await ensureGitHookShimDirectory(root);
  expect(directory).toBeTruthy();
  const first = await Bun.file(join(directory!, "pre-push")).text();
  for (const name of GIT_HOOK_SHIM_NAMES) {
    const path = join(directory!, name);
    expect(await Bun.file(path).exists()).toBe(true);
    expect((await Bun.file(path).stat()).mode & 0o777).toBe(0o700);
  }
  // Same content, same root: a second call is a no-op (idempotent), same directory returned.
  const again = await ensureGitHookShimDirectory(root);
  expect(again).toBe(directory);
  expect(await Bun.file(join(directory!, "pre-push")).text()).toBe(first);
});

/** Spawns a shim directly with `cwd` at a git worktree root, exactly as git itself invokes a hook. */
async function runShim(
  shimDirectory: string,
  name: string,
  args: readonly string[],
  cwd: string,
  stdin?: string,
): Promise<{ exitCode: number; stdout: string }> {
  const process = Bun.spawn([join(shimDirectory, name), ...args], {
    cwd,
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(10_000),
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  return { exitCode, stdout };
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "coforge-shim-repo-"));
  await Bun.spawn(["git", "init", "--quiet"], { cwd: repo }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@example.com"], { cwd: repo }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: repo }).exited;
  return repo;
}

async function writeExecutable(path: string, script: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, script);
  await chmod(path, 0o755);
}

test("the shim forwards to the repository's own hookdir hook (.git/hooks)", async () => {
  const shimDirectory = (await ensureGitHookShimDirectory(
    await mkdtemp(join(tmpdir(), "coforge-shim-root-")),
  ))!;
  const repo = await initRepo();
  const marker = join(repo, "ran-hookdir");
  await writeExecutable(
    join(repo, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\necho ran > "${marker}"\n`,
  );
  const result = await runShim(shimDirectory, "pre-commit", [], repo);
  expect(result.exitCode).toBe(0);
  expect((await readFile(marker, "utf8")).trim()).toBe("ran");
});

test("the shim honors a repository-local core.hooksPath (husky-style)", async () => {
  const shimDirectory = (await ensureGitHookShimDirectory(
    await mkdtemp(join(tmpdir(), "coforge-shim-root-")),
  ))!;
  const repo = await initRepo();
  const marker = join(repo, "ran-husky");
  await writeExecutable(
    join(repo, ".husky", "_", "pre-commit"),
    `#!/bin/sh\necho ran > "${marker}"\n`,
  );
  await Bun.spawn(["git", "config", "core.hooksPath", ".husky/_"], { cwd: repo }).exited;
  const result = await runShim(shimDirectory, "pre-commit", [], repo);
  expect(result.exitCode).toBe(0);
  expect((await readFile(marker, "utf8")).trim()).toBe("ran");
});

test("the shim forwards stdin to the repository's own hook (pre-push)", async () => {
  const shimDirectory = (await ensureGitHookShimDirectory(
    await mkdtemp(join(tmpdir(), "coforge-shim-root-")),
  ))!;
  const repo = await initRepo();
  const marker = join(repo, "ran-pre-push");
  await writeExecutable(join(repo, ".git", "hooks", "pre-push"), `#!/bin/sh\ncat > "${marker}"\n`);
  const result = await runShim(
    shimDirectory,
    "pre-push",
    ["origin", "https://example.invalid/repo.git"],
    repo,
    "refs/heads/main abc123 refs/heads/main def456\n",
  );
  expect(result.exitCode).toBe(0);
  expect(await readFile(marker, "utf8")).toBe("refs/heads/main abc123 refs/heads/main def456\n");
});

test("the shim exits without recursing when the repository's own hooksPath resolves to the shim directory itself", async () => {
  const shimDirectory = (await ensureGitHookShimDirectory(
    await mkdtemp(join(tmpdir(), "coforge-shim-root-")),
  ))!;
  const repo = await initRepo();
  await Bun.spawn(["git", "config", "core.hooksPath", shimDirectory], { cwd: repo }).exited;
  const result = await runShim(shimDirectory, "pre-commit", [], repo);
  expect(result.exitCode).toBe(0);
});

test("the prepare-commit-msg shim runs coforge git prepare-commit-msg before forwarding, and ignores its exit status", async () => {
  const shimDirectory = (await ensureGitHookShimDirectory(
    await mkdtemp(join(tmpdir(), "coforge-shim-root-")),
  ))!;
  const repo = await initRepo();
  const coforgeMarker = join(repo, "ran-coforge");
  const hookMarker = join(repo, "ran-prepare-commit-msg");
  const fakeCliDirectory = await mkdtemp(join(tmpdir(), "coforge-fake-cli-"));
  await writeExecutable(
    join(fakeCliDirectory, "coforge"),
    `#!/bin/sh\necho "$@" > "${coforgeMarker}"\nexit 7\n`,
  );
  await writeExecutable(
    join(repo, ".git", "hooks", "prepare-commit-msg"),
    `#!/bin/sh\necho ran > "${hookMarker}"\n`,
  );
  const process = Bun.spawn([join(shimDirectory, "prepare-commit-msg"), "MSG_FILE", "message"], {
    cwd: repo,
    env: { ...Bun.env, PATH: `${fakeCliDirectory}:${Bun.env.PATH}` },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(10_000),
  });
  const exitCode = await process.exited;
  expect(exitCode).toBe(0);
  expect((await readFile(coforgeMarker, "utf8")).trim()).toBe(
    "git prepare-commit-msg MSG_FILE message",
  );
  expect((await readFile(hookMarker, "utf8")).trim()).toBe("ran");
});

test("the shim exits cleanly (does not fail the git operation) when the repository has no hook of that name", async () => {
  const shimDirectory = (await ensureGitHookShimDirectory(
    await mkdtemp(join(tmpdir(), "coforge-shim-root-")),
  ))!;
  const repo = await initRepo();
  const result = await runShim(shimDirectory, "post-commit", [], repo);
  expect(result.exitCode).toBe(0);
});
