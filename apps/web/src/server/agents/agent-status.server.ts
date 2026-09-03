import { RedisClient } from "bun";
import type { AgentStatus } from "@coforge/protocol";

const ACTIVE_TTL_SECONDS = "90";
export const AGENT_STATUS_LEASE_MS = Number(ACTIVE_TTL_SECONDS) * 1_000;

export type AgentStatusScope = Pick<AgentStatus, "workspaceId" | "computerId" | "agentId">;

export interface AgentStatusCache {
  put(status: AgentStatusScope & Pick<AgentStatus, "status">): Promise<void>;
  get(scope: AgentStatusScope): Promise<AgentStatus["status"]>;
  snapshot(
    scope: AgentStatusScope,
    now?: number,
  ): Promise<{ status: AgentStatus["status"]; expiresAt: number | null }>;
}

export class RedisAgentStatusCache implements AgentStatusCache {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      ttl(key: string): Promise<number>;
      del(key: string): Promise<unknown>;
    },
  ) {}

  async put(status: AgentStatusScope & Pick<AgentStatus, "status">): Promise<void> {
    const key = this.key(status);
    if (status.status === "inactive") {
      await this.redis.del(key);
      return;
    }
    await this.redis.set(key, status.status, "EX", ACTIVE_TTL_SECONDS);
  }

  async get(scope: AgentStatusScope): Promise<AgentStatus["status"]> {
    return (await this.redis.get(this.key(scope))) === "active" ? "active" : "inactive";
  }

  async snapshot(scope: AgentStatusScope, now = Date.now()) {
    const remainingSeconds = await this.redis.ttl(this.key(scope));
    return remainingSeconds > 0
      ? { status: "active" as const, expiresAt: now + remainingSeconds * 1_000 }
      : { status: "inactive" as const, expiresAt: null };
  }

  private key(scope: AgentStatusScope): string {
    const segment = (value: string) => encodeURIComponent(value);
    return `coforge:agent-status:v1:${segment(scope.workspaceId)}:${segment(scope.computerId)}:${segment(scope.agentId)}`;
  }
}

let singleton: RedisAgentStatusCache | undefined;

export function getAgentStatusCache(): AgentStatusCache {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for Agent status");
  singleton ??= new RedisAgentStatusCache(new RedisClient(redisUrl));
  return singleton;
}
