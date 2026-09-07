import { RedisClient } from "bun";

const COMPUTER_STATUS_TTL_SECONDS = "90";
export const COMPUTER_STATUS_LEASE_MS = Number(COMPUTER_STATUS_TTL_SECONDS) * 1_000;

export type ComputerStatusScope = { workspaceId: string; computerId: string };

export interface ComputerStatusCache {
  put(scope: ComputerStatusScope, online: boolean): Promise<void>;
  get(scope: ComputerStatusScope): Promise<boolean>;
}

export class RedisComputerStatusCache implements ComputerStatusCache {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
    },
    private readonly ttlSeconds = COMPUTER_STATUS_TTL_SECONDS,
  ) {}

  async put(scope: ComputerStatusScope, online: boolean) {
    await this.redis.set(this.key(scope), online ? "online" : "offline", "EX", this.ttlSeconds);
  }

  async get(scope: ComputerStatusScope) {
    return (await this.redis.get(this.key(scope))) === "online";
  }

  private key(scope: ComputerStatusScope) {
    return `coforge:computer-status:v1:${encodeURIComponent(scope.workspaceId)}:${encodeURIComponent(scope.computerId)}`;
  }
}

let singleton: RedisComputerStatusCache | undefined;

export function getComputerStatusCache() {
  singleton ??= (() => {
    const url = Bun.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for Computer status");
    return new RedisComputerStatusCache(new RedisClient(url));
  })();
  return singleton;
}
