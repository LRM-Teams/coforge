import { RedisClient } from "bun";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

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

/** A result older than this no longer represents "now" closely enough to show without a note —
 * the same staleness rule the runtime usage cache applies. */
export const AGENT_CONTEXT_STALE_AFTER_MS = 30 * 60 * 1000;

const RESULT_TTL_SECONDS = "86400";
const SCAN_TTL_SECONDS = "60";

export interface AgentContextCache {
  putScan(record: AgentContextScanRecord): Promise<void>;
  putResult(record: AgentContextResultRecord): Promise<void>;
  read(key: AgentContextCacheKey): Promise<AgentContextReadResult>;
}

export class RedisAgentContextCache implements AgentContextCache {
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

  async putScan(record: AgentContextScanRecord) {
    await this.redis.set(this.scanKey(record), JSON.stringify(record), "EX", this.scanTtlSeconds);
  }

  async putResult(record: AgentContextResultRecord) {
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

  async read(key: AgentContextCacheKey): Promise<AgentContextReadResult> {
    const [resultValue, scanValue] = await Promise.all([
      this.redis.get(this.resultKey(key)),
      this.redis.get(this.scanKey(key)),
    ]);
    const result = this.parseResult(resultValue);
    const scan = this.parseScan(scanValue);
    const pendingScanId = scan?.status === "pending" ? scan.scanId : undefined;
    if (!result) return { state: "missing", pendingScanId };
    const age = this.now() - Date.parse(result.collectedAt);
    const state = Number.isFinite(age) && age <= AGENT_CONTEXT_STALE_AFTER_MS ? "fresh" : "stale";
    return { state, result, pendingScanId };
  }

  private parseResult(value: string | null): AgentContextResultRecord | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as AgentContextResultRecord;
    } catch {
      return undefined;
    }
  }

  private parseScan(value: string | null): AgentContextScanRecord | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as AgentContextScanRecord;
    } catch {
      return undefined;
    }
  }

  private resultKey(key: AgentContextCacheKey) {
    return `${this.scopeKey(key)}:result`;
  }
  private scanKey(key: AgentContextCacheKey) {
    return `${this.scopeKey(key)}:scan`;
  }
  private scopeKey(key: AgentContextCacheKey) {
    return `coforge:workspace:${encodeURIComponent(key.workspaceId)}:computer:${encodeURIComponent(key.computerId)}:agent:${encodeURIComponent(key.agentId)}:context-report:v1`;
  }
}

let singleton: RedisAgentContextCache | undefined;
export function getAgentContextCache() {
  singleton ??= (() => {
    const url = Bun.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for Agent context cache");
    return new RedisAgentContextCache(new RedisClient(url));
  })();
  return singleton;
}
