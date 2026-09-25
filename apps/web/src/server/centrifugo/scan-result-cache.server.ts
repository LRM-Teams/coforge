/**
 * The Redis operations a scan/result cache uses. `RedisAgentContextCache` and `RedisUsageCache` are
 * one shape: a `result` key holding the last report and a `scan` key holding a request still in
 * flight, both hanging off a scope string the cache itself owns.
 */
export type ScanResultRedisPort = {
  set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
};

/** Both caches answer "how much is true right now" for one viewer, so a result stops representing
 * "now" at the same age in both — the note the UI puts on a stale reading is the same note. */
export const SCAN_RESULT_STALE_AFTER_MS = 30 * 60 * 1000;

/** How long a result outlives the scan that produced it, and how long a scan may stay pending
 * before a read stops reporting it as in flight. */
export const SCAN_RESULT_TTL_SECONDS = "86400";
export const SCAN_TTL_SECONDS = "60";

/** The two keys one scope owns. */
export type ScanResultKeys = { result: string; scan: string };

export function scanResultKeys(scope: string): ScanResultKeys {
  return { result: `${scope}:result`, scan: `${scope}:scan` };
}

/** What one read of both keys knows: whether a result exists, whether it is still fresh, and the
 * id of a scan still in flight. */
export type ScanResultRead<Result> = {
  state: "fresh" | "stale" | "missing";
  result?: Result;
  pendingScanId?: string;
};

/**
 * Read both keys at once and answer with the reading, its freshness and any scan in flight. Shared
 * so the two caches cannot disagree about what "fresh" means, or about a pending scan's precedence:
 * a result that is not there at all is `missing` first, and a stale one still carries its result.
 * A value that is not JSON (or not shaped as expected) reads as absent rather than throwing.
 */
export async function readScanResult<Result extends { collectedAt: string }>(
  redis: ScanResultRedisPort,
  keys: ScanResultKeys,
  staleAfterMs: number,
  now: number,
): Promise<ScanResultRead<Result>> {
  const [resultValue, scanValue] = await Promise.all([
    redis.get(keys.result),
    redis.get(keys.scan),
  ]);
  const result = parseJson<Result>(resultValue);
  const scan = parseJson<{ status: "pending"; scanId: string }>(scanValue);
  const pendingScanId = scan?.status === "pending" ? scan.scanId : undefined;
  if (!result) return { state: "missing", pendingScanId };
  const age = now - Date.parse(result.collectedAt);
  return {
    state: Number.isFinite(age) && age <= staleAfterMs ? "fresh" : "stale",
    result,
    pendingScanId,
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** The one Redis URL rule, so a cache that cannot reach Redis names the feature that needed it. */
export function redisUrlFor(feature: string): string {
  const url = Bun.env.REDIS_URL;
  if (!url) throw new Error(`REDIS_URL is required for ${feature}`);
  return url;
}
