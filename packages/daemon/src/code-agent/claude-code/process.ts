import { agentEnvironment } from "../environment";

/**
 * The environment every one-shot Claude Code CLI invocation (`/usage`, `/context`) runs with:
 * Claude uses `USER` to locate the signed-in account in the macOS Keychain, and every such
 * invocation normalizes its own report to UTC without changing the parent or Agent environment.
 * Shared by `usage.ts` and `context-report.ts` so the two one-shot readers stay identical here.
 */
export function claudeCliEnvironment(
  overrides?: Readonly<Record<string, string>>,
): Record<string, string> {
  const username = Bun.env.USER;
  return {
    ...(username ? { USER: username } : {}),
    ...agentEnvironment(overrides),
    TZ: "UTC",
  };
}

export type ClaudeCliRunResult = {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
};

/** Spawns one Claude Code CLI invocation, capturing stdout and enforcing `timeoutMs`. Shared by
 * every one-shot reader (`usage.ts`, `context-report.ts`); never used for the long-lived
 * streaming session, which owns its own process lifecycle. */
export async function runClaudeCli(
  cmd: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ClaudeCliRunResult> {
  const child = Bun.spawn({ cmd: [...cmd], cwd, env, stdout: "pipe", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]).then(([stdout, exitCode]) => ({
        stdout,
        exitCode,
        timedOut: false,
      })),
      new Promise<ClaudeCliRunResult>((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve({ stdout: "", exitCode: -1, timedOut: true });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    child.kill();
  }
}
