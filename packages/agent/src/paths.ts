import { dirname, join, resolve } from "node:path";
import { mkdir, readdir, realpath } from "node:fs/promises";

const COFORGE_AGENT_DIR = ".builtin-runtime";
const COFORGE_SESSION_DIR = ".builtin-sessions";

export function getCoforgeAgentDir(workingDirectory: string): string {
  return join(workingDirectory, COFORGE_AGENT_DIR);
}

export function getCoforgeSessionDir(workingDirectory: string): string {
  return join(workingDirectory, COFORGE_SESSION_DIR);
}

/** Validate storage before a provider can discover or open any session file. */
export async function prepareAgentSessionDirectory(cwd: string, sessionDir: string) {
  const workspace = await realpath(cwd);
  if (dirname(resolve(sessionDir)) !== resolve(cwd))
    throw new Error("Session directory must be directly inside Agent workspace");
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  if (dirname(await realpath(sessionDir)) !== workspace)
    throw new Error("Session directory must be directly inside Agent workspace");
  for (const entry of await readdir(sessionDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".jsonl") && entry.isSymbolicLink())
      throw new Error("Session files must not be symbolic links");
  }
  return workspace;
}
