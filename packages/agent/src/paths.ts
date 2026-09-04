import { join } from "node:path";

const COFORGE_AGENT_DIR = ".builtin-runtime";
const COFORGE_SESSION_DIR = ".builtin-sessions";

export function getCoforgeAgentDir(workingDirectory: string): string {
  return join(workingDirectory, COFORGE_AGENT_DIR);
}

export function getCoforgeSessionDir(workingDirectory: string): string {
  return join(workingDirectory, COFORGE_SESSION_DIR);
}
