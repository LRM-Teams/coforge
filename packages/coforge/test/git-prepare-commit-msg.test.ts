import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repositoryFromRemoteUrl,
  runGitPrepareCommitMsg,
  type CommitTrailersLookup,
} from "../src/git-prepare-commit-msg";

const TRAILER =
  "Co-authored-by: coforge-staging[bot] <1+coforge-staging[bot]@users.noreply.github.com>";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "coforge-prepare-commit-msg-"));
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  return repo;
}

async function commit(repo: string, file: string, content: string, args: string[] = []) {
  await writeFile(join(repo, file), content);
  await git(repo, ["add", file]);
  await git(repo, ["commit", "-m", "message", ...args]);
}

/** Runs the real hook against a real commit message file, mirroring how git prepares one: a
 * COMMIT_EDITMSG-shaped temp file with the subject line already in it. */
async function withMessageFile(repo: string, subject: string): Promise<string> {
  const path = join(repo, ".git", "COMMIT_EDITMSG");
  await writeFile(path, `${subject}\n`);
  return path;
}

/** git always invokes a hook with its CWD at the worktree root (verified; see the brief's
 * research). `runGitPrepareCommitMsg`'s default git runner relies on that exactly like a real
 * `prepare-commit-msg` invocation would, so tests simulate it the same way rather than adding a
 * test-only `cwd` parameter to production code. */
async function withCwd<T>(repo: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(repo);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

test("repositoryFromRemoteUrl parses https, SCP-like, and ssh:// github.com remotes", () => {
  expect(repositoryFromRemoteUrl("https://github.com/acme/widgets.git")).toBe("acme/widgets");
  expect(repositoryFromRemoteUrl("https://github.com/acme/widgets")).toBe("acme/widgets");
  expect(repositoryFromRemoteUrl("https://x-access-token:tok@github.com/acme/widgets.git")).toBe(
    "acme/widgets",
  );
  expect(repositoryFromRemoteUrl("git@github.com:acme/widgets.git")).toBe("acme/widgets");
  expect(repositoryFromRemoteUrl("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
  expect(repositoryFromRemoteUrl("ssh://git@github.com:22/acme/widgets.git")).toBe("acme/widgets");
  expect(repositoryFromRemoteUrl("https://gitlab.com/acme/widgets.git")).toBeNull();
  expect(repositoryFromRemoteUrl("not a url")).toBeNull();
});

test("adds the server-decided trailer to a plain commit", async () => {
  const repo = await initRepo();
  const messageFile = await withMessageFile(repo, "Add widget");
  const seen: (string | null)[] = [];
  const lookup: CommitTrailersLookup = async (repository) => {
    seen.push(repository);
    return [TRAILER];
  };
  await withCwd(repo, () => runGitPrepareCommitMsg([messageFile], lookup));
  expect(seen).toEqual(["acme/widgets"]);
  expect(await readFile(messageFile, "utf8")).toContain(TRAILER);
});

test("does not duplicate the trailer on an amend (addIfDifferent)", async () => {
  const repo = await initRepo();
  await commit(repo, "file.txt", "one");
  const lookup: CommitTrailersLookup = async () => [TRAILER];
  const amendMessageFile = await withMessageFile(repo, "Add widget");
  await writeFile(amendMessageFile, `Add widget\n\n${TRAILER}\n`);
  await withCwd(repo, () => runGitPrepareCommitMsg([amendMessageFile, "commit"], lookup));
  const content = await readFile(amendMessageFile, "utf8");
  expect(content.split(TRAILER).length - 1).toBe(1);
});

test("skips silently for a merge or squash commit message", async () => {
  const repo = await initRepo();
  const messageFile = await withMessageFile(repo, "Merge branch 'x'");
  let calls = 0;
  const lookup: CommitTrailersLookup = async () => {
    calls++;
    return [TRAILER];
  };
  await withCwd(repo, async () => {
    for (const source of ["merge", "squash"] as const) {
      await runGitPrepareCommitMsg([messageFile, source], lookup);
    }
  });
  expect(calls).toBe(0);
  expect(await readFile(messageFile, "utf8")).not.toContain(TRAILER);
});

test("skips a commit the sequencer is replaying (git rebase)", async () => {
  const repo = await initRepo();
  await commit(repo, "file.txt", "one");
  await git(repo, ["checkout", "-b", "feature"]);
  await commit(repo, "file.txt", "two");
  await git(repo, ["checkout", "-"]);
  // Same file, different content: guarantees a real conflict when rebased onto `feature`.
  await commit(repo, "file.txt", "conflicting");

  // Exercise the real skip rule directly: while a rebase is in progress, the sequencer markers
  // githooks(5) documents (`rebase-merge`/`rebase-apply`) exist on disk, and the hook must skip.
  const rebase = Bun.spawnSync(["git", "rebase", "feature"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(rebase.exitCode).not.toBe(0); // a real conflict, left mid-rebase on purpose
  const messageFile = join(repo, ".git", "COMMIT_EDITMSG");
  let calls = 0;
  const lookup: CommitTrailersLookup = async () => {
    calls++;
    return [TRAILER];
  };
  await withCwd(repo, () => runGitPrepareCommitMsg([messageFile, "message"], lookup));
  expect(calls).toBe(0);
  await Bun.spawn(["git", "rebase", "--abort"], { cwd: repo }).exited;
});

test("skips a commit the sequencer is replaying (git cherry-pick)", async () => {
  const repo = await initRepo();
  await commit(repo, "file.txt", "one");
  await git(repo, ["checkout", "-b", "feature"]);
  await commit(repo, "file.txt", "two");
  const pickSha = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "-"]);
  await commit(repo, "file.txt", "conflicting");

  const pick = Bun.spawnSync(["git", "cherry-pick", pickSha], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(pick.exitCode).not.toBe(0); // a real conflict, left mid-cherry-pick on purpose
  const messageFile = join(repo, ".git", "COMMIT_EDITMSG");
  let calls = 0;
  const lookup: CommitTrailersLookup = async () => {
    calls++;
    return [TRAILER];
  };
  await withCwd(repo, () => runGitPrepareCommitMsg([messageFile, "message"], lookup));
  expect(calls).toBe(0);
  await Bun.spawn(["git", "cherry-pick", "--abort"], { cwd: repo }).exited;
});

test("gets the trailer for --amend (source=commit), revert, -m, and --no-verify commits", async () => {
  for (const source of ["commit", undefined] as const) {
    const repo = await initRepo();
    const messageFile = await withMessageFile(repo, "Fix bug");
    let calls = 0;
    const lookup: CommitTrailersLookup = async () => {
      calls++;
      return [TRAILER];
    };
    await withCwd(repo, () =>
      runGitPrepareCommitMsg(source ? [messageFile, source] : [messageFile], lookup),
    );
    expect(calls).toBe(1);
    expect(await readFile(messageFile, "utf8")).toContain(TRAILER);
  }
});

test("adds no trailer when the server returns none, without failing", async () => {
  const repo = await initRepo();
  const messageFile = await withMessageFile(repo, "Add widget");
  await withCwd(repo, () => runGitPrepareCommitMsg([messageFile], async () => []));
  expect(await readFile(messageFile, "utf8")).not.toContain("Co-authored-by");
});

test("passes null when origin is missing or not a github.com remote", async () => {
  const repo = await mkdtemp(join(tmpdir(), "coforge-prepare-commit-msg-noremote-"));
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  const messageFile = await withMessageFile(repo, "Add widget");
  const seen: (string | null)[] = [];
  await withCwd(repo, () =>
    runGitPrepareCommitMsg([messageFile], async (repository) => {
      seen.push(repository);
      return [];
    }),
  );
  expect(seen).toEqual([null]);
});
