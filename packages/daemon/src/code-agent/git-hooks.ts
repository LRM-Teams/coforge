import type { AgentGitHookPlan } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { ensureGitHookShimDirectory } from "./git-hook-shims";
import { versionProbeOutput } from "./runtime-inventory";

const logger = getLogger(["coforge", "daemon", "code-agent", "git-hooks"]);

/** git 2.54 (April 2026) is the first release with config-based hooks. */
const MIN_CONFIG_HOOK_VERSION = [2, 54] as const;

function compareVersion(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseGitVersion(output: string): number[] | undefined {
  const match = output.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

type ProbedKind = AgentGitHookPlan["kind"] | undefined;

/** Probes `git --version` on one resolved git executable path once per Daemon process, keyed by
 * that path so every Agent launch that resolves the same git binary (the common case) reuses the
 * answer instead of spawning `git --version` again. */
const probeCache = new Map<string, Promise<ProbedKind>>();

/** Test-only: clears the memoized version-probe cache so a fresh probe runs again. */
export function resetGitHookVersionProbeCacheForTests(): void {
  probeCache.clear();
}

async function probeGitHookKind(gitPath: string): Promise<ProbedKind> {
  let cached = probeCache.get(gitPath);
  if (!cached) {
    cached = (async (): Promise<ProbedKind> => {
      try {
        const process = Bun.spawn([gitPath, "--version"], { stdout: "pipe", stderr: "ignore" });
        const { output, exitCode } = await versionProbeOutput(process).finally(() =>
          process.kill(),
        );
        if (exitCode !== 0) return undefined;
        const version = parseGitVersion(output);
        if (!version) return undefined;
        return compareVersion(version, MIN_CONFIG_HOOK_VERSION) >= 0 ? "config-hook" : "hooks-path";
      } catch (error) {
        logger.warn("git --version probe failed; commit co-author trailer hook not injected", {
          event: "code-agent.git-hooks.probe-failed",
          gitPath,
          error: String(error),
        });
        return undefined;
      }
    })();
    probeCache.set(gitPath, cached);
  }
  return cached;
}

/**
 * Decides how (if at all) to inject the commit co-author trailer hook for an Agent about to
 * launch, given the exact `PATH` that Agent's git invocations will search. Missing git, an
 * unparseable `git --version`, or (for a pre-2.54 git) a shim directory that could not be
 * prepared all resolve to `undefined` - never inject anything rather than guess. The shim
 * directory holds POSIX `sh` scripts, so the `hooks-path` path is skipped on `win32` (a known
 * gap: a pre-2.54 git on Windows gets no trailer; `config-hook` is unaffected).
 */
export async function resolveGitHookInjectionForLaunch(
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<AgentGitHookPlan | undefined> {
  const gitPath = Bun.which("git", { PATH: path ?? "" });
  if (!gitPath) return undefined;
  const kind = await probeGitHookKind(gitPath);
  if (kind === "config-hook") return { kind: "config-hook" };
  if (kind === "hooks-path" && platform !== "win32") {
    const hooksDir = await ensureGitHookShimDirectory();
    if (hooksDir) return { kind: "hooks-path", hooksDir };
  }
  return undefined;
}
