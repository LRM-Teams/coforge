import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodeAgentModelCatalog, RuntimeMetadata } from "@lrm/coforge-sdk/internal";

/**
 * One provider's cached probe result, keyed by a snapshot of whatever on-disk state the probe
 * depends on (an executable's mtime+size, or a config file's). A stale key means the cached value
 * must not be trusted; the caller re-probes and overwrites the entry.
 */
export type ProbeCacheEntry = {
  key: string;
  runtime?: RuntimeMetadata;
  catalog?: CodeAgentModelCatalog;
  /** When the cached catalog was probed live; a fresh key past this age still refreshes. */
  catalogProbedAt?: number;
};

/** Model lists change server-side without the CLI binary changing, so a key match alone is not
 * enough to trust a catalog forever; a daily background refresh keeps it honest. */
export const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type ProbeCache = Partial<Record<string, ProbeCacheEntry>>;

const CACHE_FILE_NAME = "code-agent-inventory-cache.json";

export function inventoryCachePath(stateDirectory: string): string {
  return join(stateDirectory, CACHE_FILE_NAME);
}

/** A missing or unreadable cache is treated as empty; discovery must never fail because of it. */
export async function readInventoryCache(stateDirectory: string): Promise<ProbeCache> {
  try {
    const raw: unknown = await Bun.file(inventoryCachePath(stateDirectory)).json();
    return raw && typeof raw === "object" ? (raw as ProbeCache) : {};
  } catch {
    return {};
  }
}

/** Best-effort write; a cache that cannot be persisted only costs the next restart a re-probe. */
export async function writeInventoryCache(
  stateDirectory: string,
  cache: ProbeCache,
): Promise<void> {
  try {
    await Bun.write(inventoryCachePath(stateDirectory), JSON.stringify(cache));
  } catch {
    // A cache write failure must never fail discovery.
  }
}

/**
 * Builds a stable cache key from one or more files' mtime and size. Returns undefined when any
 * file cannot be stat'd (missing, unreadable), which every caller treats as an unconditional
 * cache miss.
 */
export async function fileStatCacheKey(paths: readonly string[]): Promise<string | undefined> {
  if (!paths.length) return undefined;
  try {
    const stats = await Promise.all(paths.map((path) => stat(path)));
    return paths
      .map((path, index) => `${path}:${stats[index]!.mtimeMs}:${stats[index]!.size}`)
      .join("|");
  } catch {
    return undefined;
  }
}
