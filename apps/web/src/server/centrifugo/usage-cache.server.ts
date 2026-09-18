import { RedisClient } from "bun";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

export type UsageCacheKey = {
  workspaceId: string;
  computerId: string;
  provider: RuntimeProvider;
};
export type UsageSnapshot = {
  provider: RuntimeProvider;
  planType?: string;
  primary?: {
    usedPercent?: number;
    status?: "available" | "rate-limited";
    windowDurationMinutes: number;
    resetsAt: string;
  };
  secondary?: {
    usedPercent?: number;
    status?: "available" | "rate-limited";
    windowDurationMinutes: number;
    resetsAt: string;
  };
  credits?: { hasCredits: boolean; unlimited: boolean };
  creditUsage?: { used: number; limit: number; overage: number };
  /** ISO instant the Computer actually observed this snapshot at. Older Computers omit it. */
  collectedAt?: string;
  /** The signed-in account, already masked on the Computer. Populated only when that provider's
   * usage/auth read reports it. */
  accountLabel?: string;
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

/** A result older than this no longer represents "now" closely enough to show without a note. */
export const USAGE_STALE_AFTER_MS = 30 * 60 * 1000;

const RESULT_TTL_SECONDS = "86400";
const SCAN_TTL_SECONDS = "60";

export interface UsageCache {
  putScan(record: UsageScanRecord): Promise<void>;
  putResult(record: UsageResultRecord): Promise<void>;
  read(key: UsageCacheKey): Promise<UsageReadResult>;
}

export class RedisUsageCache implements UsageCache {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      del(...keys: string[]): Promise<number>;
    },
    private readonly resultTtlSeconds = RESULT_TTL_SECONDS,
    private readonly scanTtlSeconds = SCAN_TTL_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  async putScan(record: UsageScanRecord) {
    await this.redis.set(this.scanKey(record), JSON.stringify(record), "EX", this.scanTtlSeconds);
  }

  async putResult(record: UsageResultRecord) {
    await this.redis.set(
      this.resultKey(record),
      JSON.stringify(record),
      "EX",
      this.resultTtlSeconds,
    );
    // This scan is no longer in flight; clear it so its own 60s TTL never has to expire first
    // before a later read stops reporting it as pending.
    await this.redis.del(this.scanKey(record));
  }

  async read(key: UsageCacheKey): Promise<UsageReadResult> {
    const [resultValue, scanValue] = await Promise.all([
      this.redis.get(this.resultKey(key)),
      this.redis.get(this.scanKey(key)),
    ]);
    const result = this.parseResult(resultValue);
    const scan = this.parseScan(scanValue);
    const pendingScanId = scan?.status === "pending" ? scan.scanId : undefined;
    if (!result) return { state: "missing", pendingScanId };
    const age = this.now() - Date.parse(result.collectedAt);
    const state = Number.isFinite(age) && age <= USAGE_STALE_AFTER_MS ? "fresh" : "stale";
    return { state, result, pendingScanId };
  }

  private parseResult(value: string | null): UsageResultRecord | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as UsageResultRecord;
    } catch {
      return undefined;
    }
  }

  private parseScan(value: string | null): UsageScanRecord | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as UsageScanRecord;
    } catch {
      return undefined;
    }
  }

  private resultKey(key: UsageCacheKey) {
    return `${this.scopeKey(key)}:result`;
  }
  private scanKey(key: UsageCacheKey) {
    return `${this.scopeKey(key)}:scan`;
  }
  private scopeKey(key: UsageCacheKey) {
    return `coforge:workspace:${encodeURIComponent(key.workspaceId)}:computer:${encodeURIComponent(key.computerId)}:usage:v2:${encodeURIComponent(key.provider)}`;
  }
}

let singleton: RedisUsageCache | undefined;
export function getUsageCache() {
  singleton ??= (() => {
    const url = Bun.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for usage cache");
    return new RedisUsageCache(new RedisClient(url));
  })();
  return singleton;
}
