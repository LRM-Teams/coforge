import { readFileSync } from "node:fs";

/** PublicChannel quiet window before the sweep admits a segment. */
export const CAUSAL_QUIET_WINDOW_MS = 15 * 60 * 1000;

export function causalMemoryRuntimeUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.COFORGE_CAUSAL_MEMORY_URL ?? "http://causal-memory:9938";
}

export function tenantTokenForWorkspace(
  _workspaceId: string,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = env.COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE;
  if (!path) throw new Error("causal tenant token file is not configured");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  const match = Object.entries(raw).find(([, tenant]) => tenant === tenantId);
  if (!match) throw new Error("causal tenant token is missing");
  return match[0];
}
