import { join } from "node:path";

function userHomeDirectory(): string {
  return Bun.env.HOME ?? Bun.env.USERPROFILE ?? "";
}

/** Resolve the Claude Code CLI, including the executable shipped in the macOS app. */
export async function resolveClaudeCodeExecutable(
  which: (name: string) => string | undefined,
): Promise<string | undefined> {
  const fromPath = which("claude");
  if (fromPath) return fromPath;
  if (process.platform !== "darwin") return undefined;
  for (const candidate of [
    "/Applications/Claude Code URL Handler.app/Contents/MacOS/claude",
    join(userHomeDirectory(), "Applications/Claude Code URL Handler.app/Contents/MacOS/claude"),
    "/Applications/Claude Code.app/Contents/MacOS/claude",
    join(userHomeDirectory(), "Applications/Claude Code.app/Contents/MacOS/claude"),
  ]) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

export async function probeClaudeCodeVersion(
  executable: string,
  spawn: (executable: string) => {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill?(): void;
  },
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const child = spawn(executable);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill?.();
          reject(new Error("Claude Code version probe timed out"));
        }, timeoutMs);
      }),
    ]);
    const [output, exitCode] = result;
    if (exitCode !== 0) return undefined;
    return output.trim().match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
    child.kill?.();
  }
}
