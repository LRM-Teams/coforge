import { RedisClient } from "bun";
import type { RuntimeProvider } from "@coforge/protocol";

export type UsageCacheKey = { workspaceId: string; computerId: string; provider: RuntimeProvider };
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
};
export type UsageCacheRecord = UsageCacheKey & {
  scanId: string;
  status: "pending" | "available" | "unavailable" | "reauth" | "unsupported" | "error";
  message?: string;
  snapshot?: UsageSnapshot;
};

export interface UsageCache {
  put(record: UsageCacheRecord): Promise<void>;
  get(key: UsageCacheKey): Promise<UsageCacheRecord | undefined>;
}

export class RedisUsageCache implements UsageCache {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
    },
    private readonly ttlSeconds = "60",
  ) {}
  async put(record: UsageCacheRecord) {
    await this.redis.set(this.key(record), JSON.stringify(record), "EX", this.ttlSeconds);
  }
  async get(key: UsageCacheKey) {
    const value = await this.redis.get(this.key(key));
    return value ? (JSON.parse(value) as UsageCacheRecord) : undefined;
  }
  private key(key: UsageCacheKey) {
    return `coforge:usage:v1:${encodeURIComponent(key.workspaceId)}:${encodeURIComponent(key.computerId)}:${encodeURIComponent(key.provider)}`;
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
