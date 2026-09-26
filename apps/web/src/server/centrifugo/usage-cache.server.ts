import { RedisClient } from "bun";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import {
  SCAN_RESULT_STALE_AFTER_MS,
  SCAN_RESULT_TTL_SECONDS,
  SCAN_TTL_SECONDS,
  readScanResult,
  scanResultKeys,
  type ScanResultRedisPort,
} from "./scan-result-cache.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

export type UsageCacheKey = {
  workspaceId: string;
  computerId: string;
  provider: RuntimeProvider;
};
export type UsageSnapshot = {
  provider: RuntimeProvider;
  planType?: string;
  primary?: {
    id?: string;
    usedPercent?: number;
    status?: "ok" | "limit_reached" | "parse_unavailable";
    windowDurationMinutes: number;
    resetsAt?: string;
  };
  secondary?: {
    id?: string;
    usedPercent?: number;
    status?: "ok" | "limit_reached" | "parse_unavailable";
    windowDurationMinutes: number;
    resetsAt?: string;
  };
  credits?: { hasCredits: boolean; unlimited: boolean };
  creditUsage?: { used: number; limit: number; overage: number };
  /** ISO instant the Computer actually observed this snapshot at. Older Computers omit it. */
  collectedAt?: string;
  /** The signed-in account, already masked on the Computer. Populated only when that provider's
   * usage/auth read reports it. */
  accountLabel?: string;
  /** Raft-aligned account-level health: `rate_limited` once any reported window is at its
   * limit, `ok` otherwise. Older Computers omit it. */
  health?: "ok" | "rate_limited" | "reauth_required" | "unsupported" | "error";
};

/** The last completed scan for one (Workspace, Computer, provider) — kept separately from the
 * in-flight scan record below so starting a new scan never erases the previous result. */
export type UsageResultRecord = UsageCacheKey & {
  scanId: string;
  status: "available" | "unavailable" | "reauth" | "unsupported" | "error";
  message?: string;
  snapshot?: UsageSnapshot;
  /** When this result was actually observed: the snapshot's own `collectedAt` when the Computer
   * reported one, otherwise the time the server received this scan result. */
  collectedAt: string;
};

/** A scan the server asked the Computer to run and hasn't seen a result for yet. */
export type UsageScanRecord = UsageCacheKey & {
  scanId: string;
  status: "pending";
};

export type UsageReadResult = {
  state: "fresh" | "stale" | "missing";
  result?: UsageResultRecord;
  pendingScanId?: string;
};

/** A result older than this no longer represents "now" closely enough to show without a note. The
 * rule is the shared scan/result one the Agent-context report applies too
 * (`SCAN_RESULT_STALE_AFTER_MS`); it keeps this name for this cache's readers. */
export const USAGE_STALE_AFTER_MS = SCAN_RESULT_STALE_AFTER_MS;

/**
 * Write the result and clear the in-flight scan in one round trip. They are one fact — the scan is
 * over because the result exists — so a reader should never be able to observe the two halves of
 * this write separately, and the writer should not pay two round trips on the report path. ARGV:
 * the encoded result, then its TTL; KEYS: the result key, then the scan key.
 */
const PUT_RESULT = `
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("DEL", KEYS[2])
return 1
`;

export interface UsageCache {
  putScan(record: UsageScanRecord): Promise<void>;
  putResult(record: UsageResultRecord): Promise<void>;
  read(key: UsageCacheKey): Promise<UsageReadResult>;
}

/** This cache writes its result and clears the scan in one round trip, so its port also carries
 * `eval`. */
type UsageCacheRedis = ScanResultRedisPort & {
  eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArgs: Array<string | number>
  ): Promise<unknown>;
};

export class RedisUsageCache implements UsageCache {
  constructor(
    private readonly redis: UsageCacheRedis,
    private readonly resultTtlSeconds = SCAN_RESULT_TTL_SECONDS,
    private readonly scanTtlSeconds = SCAN_TTL_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  async putScan(record: UsageScanRecord) {
    const keys = scanResultKeys(this.scopeKey(record));
    await this.redis.set(keys.scan, JSON.stringify(record), "EX", this.scanTtlSeconds);
  }

  async putResult(record: UsageResultRecord) {
    const keys = scanResultKeys(this.scopeKey(record));
    // This scan is no longer in flight; clear it in the same transaction, so its own 60s TTL never
    // has to expire first before a later read stops reporting it as pending.
    await this.redis.eval(
      PUT_RESULT,
      2,
      keys.result,
      keys.scan,
      JSON.stringify(record),
      this.resultTtlSeconds,
    );
  }

  async read(key: UsageCacheKey): Promise<UsageReadResult> {
    return readScanResult<UsageResultRecord>(
      this.redis,
      scanResultKeys(this.scopeKey(key)),
      USAGE_STALE_AFTER_MS,
      this.now(),
    );
  }

  private scopeKey(key: UsageCacheKey) {
    return `${workspaceRedisKey({
      workspaceId: key.workspaceId,
      computerId: key.computerId,
      name: "usage",
      version: "v2",
    })}:${encodeURIComponent(key.provider)}`;
  }
}

let singleton: RedisUsageCache | undefined;
export function getUsageCache() {
  singleton ??= new RedisUsageCache(new RedisClient(redisUrlFor("usage cache")));
  return singleton;
}
