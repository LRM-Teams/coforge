import { stat } from "node:fs/promises";
import { githubOwnerRepoName } from "./github-credential";

/** Asks the server (through the Daemon's local Agent proxy) which `Co-authored-by` trailers, if
 * any, this commit should carry; the CLI never decides the trailer content itself. */
export type CommitTrailersLookup = (repository: string | null) => Promise<string[]>;

type GitCommandResult = { stdout: string; stderr: string; exitCode: number };

/** Runs one `git` subcommand with a short timeout - this hook must never hang a commit. */
async function runGit(args: readonly string[]): Promise<GitCommandResult> {
  const process = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(5_000),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export type GitRunner = (args: readonly string[]) => Promise<GitCommandResult>;

/**
 * Extracts `owner/repo` from a github.com remote URL (https, SCP-like, or `ssh://`), or `null`
 * for anything else - a non-github.com remote, or a URL this parser does not recognize.
 */
export function repositoryFromRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const ssh = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/(.+)$/i);
  if (ssh?.[1]) return githubOwnerRepoName(ssh[1]);
  const https = trimmed.match(/^https:\/\/(?:[^@/]+@)?github\.com\/(.+)$/i);
  if (https?.[1]) return githubOwnerRepoName(https[1]);
  const scpLike = trimmed.match(/^(?:[^@/]+@)?github\.com:(.+)$/i);
  if (scpLike?.[1]) return githubOwnerRepoName(scpLike[1]);
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A rebase or cherry-pick in progress replays someone else's already-authored commits through
 * `prepare-commit-msg` (source `message`); those must never gain a CoForge trailer, so this skips
 * whenever the sequencer markers `githooks(5)` documents for either are present (verified: plain
 * `git rebase` and `git cherry-pick` fire `prepare-commit-msg` this way). */
async function sequencerInProgress(git: GitRunner): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"] as const) {
    const result = await git(["rev-parse", "--git-path", name]);
    if (result.exitCode === 0 && result.stdout && (await pathExists(result.stdout))) return true;
  }
  return false;
}

/**
 * `coforge git prepare-commit-msg <msgfile> [source] [sha]`: adds the CoForge co-author trailer
 * this Agent's commit should carry, decided entirely by the server (`lookup`). Skips silently for
 * a merge/squash commit message and for any commit the sequencer (rebase/cherry-pick) is
 * replaying - see `sequencerInProgress`. Every other commit (plain, `--amend`, revert, `-m`, an
 * editor commit, `--no-verify`) gets it. Trailers are applied with `--if-exists addIfDifferent`,
 * so amending an already-trailered commit never duplicates the line.
 *
 * Throws on any failure; the caller (`cli.ts`) must catch it, print one explanatory line, and
 * still exit 0 - a nonzero `prepare-commit-msg` aborts the Agent's commit, and a skipped trailer
 * must never do that.
 */
export async function runGitPrepareCommitMsg(
  args: readonly string[],
  lookup: CommitTrailersLookup,
  git: GitRunner = runGit,
): Promise<void> {
  const [messageFile, source] = args;
  if (!messageFile) throw new Error("prepare-commit-msg requires a commit message file argument");
  if (source === "merge" || source === "squash") return;
  if (await sequencerInProgress(git)) return;
  const remote = await git(["remote", "get-url", "origin"]);
  const repository = remote.exitCode === 0 ? repositoryFromRemoteUrl(remote.stdout) : null;
  const trailers = await lookup(repository);
  for (const trailer of trailers) {
    const result = await git([
      "interpret-trailers",
      "--in-place",
      "--if-exists",
      "addIfDifferent",
      "--trailer",
      trailer,
      messageFile,
    ]);
    if (result.exitCode !== 0)
      throw new Error(`git interpret-trailers failed${result.stderr ? `: ${result.stderr}` : ""}`);
  }
}
