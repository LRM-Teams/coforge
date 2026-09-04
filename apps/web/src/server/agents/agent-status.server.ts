import { RedisClient } from "bun";
import type { AgentStatus } from "@coforge/protocol";

const ACTIVE_TTL_SECONDS = "90";
export const AGENT_STATUS_LEASE_MS = Number(ACTIVE_TTL_SECONDS) * 1_000;

export type AgentStatusScope = Pick<AgentStatus, "workspaceId" | "computerId" | "agentId">;
export type OrderedAgentStatus = Pick<
  AgentStatus,
  "status" | "daemonInstanceId" | "clientSeq" | "observedAtMs"
>;
export type AgentStatusSnapshot = OrderedAgentStatus & { expiresAt: number | null };

const PUT_AGENT_STATUS = `
local raw = redis.call("GET", KEYS[1])
if raw then
  local decoded, current = pcall(cjson.decode, raw)
  if decoded and type(current) == "table" then
    local same_instance = current.daemonInstanceId == ARGV[2]
    local accepted = false
    if same_instance then
      local current_seq = tonumber(current.clientSeq)
      local next_seq = tonumber(ARGV[3])
      accepted = current_seq and (
        next_seq > current_seq or
        (next_seq == current_seq and current.status == ARGV[5] and
          tonumber(current.observedAtMs) == tonumber(ARGV[4]))
      )
    else
      accepted = tonumber(current.observedAtMs) and
        tonumber(ARGV[4]) > tonumber(current.observedAtMs)
    end
    if not accepted then return 0 end
  end
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[6])
return 1
`;

export interface AgentStatusCache {
  put(status: AgentStatusScope & OrderedAgentStatus): Promise<boolean>;
  get(scope: AgentStatusScope): Promise<AgentStatus["status"]>;
  snapshot(scope: AgentStatusScope, now?: number): Promise<AgentStatusSnapshot | undefined>;
}

export class RedisAgentStatusCache implements AgentStatusCache {
  constructor(
    private readonly redis: {
      eval(
        script: string,
        numberOfKeys: number,
        ...keysAndArgs: Array<string | number>
      ): Promise<unknown>;
      get(key: string): Promise<string | null>;
      ttl(key: string): Promise<number>;
    },
  ) {}

  async put(status: AgentStatusScope & OrderedAgentStatus): Promise<boolean> {
    const key = this.key(status);
    const record: OrderedAgentStatus = {
      status: status.status,
      daemonInstanceId: status.daemonInstanceId,
      clientSeq: status.clientSeq,
      observedAtMs: status.observedAtMs,
    };
    const accepted = await this.redis.eval(
      PUT_AGENT_STATUS,
      1,
      key,
      JSON.stringify(record),
      status.daemonInstanceId,
      status.clientSeq,
      status.observedAtMs,
      status.status,
      ACTIVE_TTL_SECONDS,
    );
    return accepted === 1;
  }

  async get(scope: AgentStatusScope): Promise<AgentStatus["status"]> {
    return this.parse(await this.redis.get(this.key(scope)))?.status ?? "inactive";
  }

  async snapshot(scope: AgentStatusScope, now = Date.now()) {
    const key = this.key(scope);
    const [record, remainingSeconds] = await Promise.all([
      this.redis.get(key).then((value) => this.parse(value)),
      this.redis.ttl(key),
    ]);
    if (!record || remainingSeconds <= 0) return undefined;
    return {
      ...record,
      expiresAt: record.status === "active" ? now + remainingSeconds * 1_000 : null,
    };
  }

  private parse(value: string | null): OrderedAgentStatus | undefined {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const status = Reflect.get(parsed, "status");
      const daemonInstanceId = Reflect.get(parsed, "daemonInstanceId");
      const clientSeq = Reflect.get(parsed, "clientSeq");
      const observedAtMs = Reflect.get(parsed, "observedAtMs");
      if (
        (status !== "active" && status !== "inactive") ||
        typeof daemonInstanceId !== "string" ||
        !daemonInstanceId ||
        !Number.isSafeInteger(clientSeq) ||
        clientSeq < 1 ||
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 1
      )
        return undefined;
      return { status, daemonInstanceId, clientSeq, observedAtMs };
    } catch {
      return undefined;
    }
  }

  private key(scope: AgentStatusScope): string {
    const segment = (value: string) => encodeURIComponent(value);
    return `coforge:agent-status:v2:${segment(scope.workspaceId)}:${segment(scope.computerId)}:${segment(scope.agentId)}`;
  }
}

let singleton: RedisAgentStatusCache | undefined;

export function getAgentStatusCache(): AgentStatusCache {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for Agent status");
  singleton ??= new RedisAgentStatusCache(new RedisClient(redisUrl));
  return singleton;
}
