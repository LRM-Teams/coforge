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

export type AgentContextCacheKey = {
  workspaceId: string;
  computerId: string;
  agentId: string;
};

/** A parsed Claude Code context report, exactly the SDK's `AgentContextReport` shape. */
export type AgentContextReport = {
  provider: RuntimeProvider;
  model?: string;
  usedTokens: number;
  windowTokens: number;
  observedAt: string;
  categories: { name: string; tokens: number; approximate?: boolean }[];
  memoryFiles?: { kind: string; path: string; tokens: number; approximate?: boolean }[];
  skills?: { name: string; source: string; tokens: number; approximate?: boolean }[];
};

export type AgentContextScanStatus =
  | "available"
  | "unsupported"
  | "no_session"
  | "unparsed"
  | "timeout"
  | "error";

/** The last completed scan for one Agent — kept separately from the in-flight scan record below
 * so starting a new scan never erases the previous result. */
export type AgentContextResultRecord = AgentContextCacheKey & {
  scanId: string;
  status: AgentContextScanStatus;
  message?: string;
  report?: AgentContextReport;
  /** When the Computer actually observed this report; the server fills this in from the report's
   * own `observedAt` (falling back to receive time) before storing. */
  collectedAt: string;
};

/** A scan the server asked the Computer to run and hasn't seen a result for yet. */
export type AgentContextScanRecord = AgentContextCacheKey & {
  scanId: string;
  status: "pending";
};

export type AgentContextReadResult = {
  state: "fresh" | "stale" | "missing";
  result?: AgentContextResultRecord;
  pendingScanId?: string;
};

/** A result older than this no longer represents "now" closely enough to show without a note. The
 * rule is the shared scan/result one the runtime usage cache applies too
 * (`SCAN_RESULT_STALE_AFTER_MS`); it keeps this name for this cache's readers. */
export const AGENT_CONTEXT_STALE_AFTER_MS = SCAN_RESULT_STALE_AFTER_MS;

export interface AgentContextCache {
  putScan(record: AgentContextScanRecord): Promise<void>;
  putResult(record: AgentContextResultRecord): Promise<void>;
  read(key: AgentContextCacheKey): Promise<AgentContextReadResult>;
}

export class RedisAgentContextCache implements AgentContextCache {
  constructor(
    private readonly redis: ScanResultRedisPort,
    private readonly resultTtlSeconds = SCAN_RESULT_TTL_SECONDS,
    private readonly scanTtlSeconds = SCAN_TTL_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  async putScan(record: AgentContextScanRecord) {
    const keys = scanResultKeys(this.scopeKey(record));
    await this.redis.set(keys.scan, JSON.stringify(record), "EX", this.scanTtlSeconds);
  }

  async putResult(record: AgentContextResultRecord) {
    const keys = scanResultKeys(this.scopeKey(record));
    await this.redis.set(keys.result, JSON.stringify(record), "EX", this.resultTtlSeconds);
    // This scan is no longer in flight; clear it so its own 60s TTL never has to expire first
    // before a later read stops reporting it as pending.
    await this.redis.del(keys.scan);
  }

  async read(key: AgentContextCacheKey): Promise<AgentContextReadResult> {
    return readScanResult<AgentContextResultRecord>(
      this.redis,
      scanResultKeys(this.scopeKey(key)),
      AGENT_CONTEXT_STALE_AFTER_MS,
      this.now(),
    );
  }

  private scopeKey(key: AgentContextCacheKey) {
    return `coforge:workspace:${encodeURIComponent(key.workspaceId)}:computer:${encodeURIComponent(key.computerId)}:agent:${encodeURIComponent(key.agentId)}:context-report:v1`;
  }
}

let singleton: RedisAgentContextCache | undefined;
export function getAgentContextCache() {
  singleton ??= new RedisAgentContextCache(new RedisClient(redisUrlFor("Agent context cache")));
  return singleton;
}
