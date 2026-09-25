import { RedisClient } from "bun";
import { redisUrlFor } from "#src/server/redis-url.server";

const COMPUTER_STATUS_TTL_SECONDS = "90";
export const COMPUTER_STATUS_LEASE_MS = Number(COMPUTER_STATUS_TTL_SECONDS) * 1_000;

export type ComputerStatusScope = { workspaceId: string; computerId: string };

export interface ComputerStatusCache {
  put(scope: ComputerStatusScope, online: boolean): Promise<void>;
  get(scope: ComputerStatusScope): Promise<boolean>;
  /** One round trip for many Computers (the list page's shape); missing keys read as
   * offline, exactly like `get`. Returns statuses in the scopes' order. */
  getMany(scopes: readonly ComputerStatusScope[]): Promise<boolean[]>;
}

export class RedisComputerStatusCache implements ComputerStatusCache {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      mget(...keys: string[]): Promise<Array<string | null>>;
    },
    private readonly ttlSeconds = COMPUTER_STATUS_TTL_SECONDS,
  ) {}

  async put(scope: ComputerStatusScope, online: boolean) {
    await this.redis.set(this.key(scope), online ? "online" : "offline", "EX", this.ttlSeconds);
  }

  async get(scope: ComputerStatusScope) {
    return (await this.redis.get(this.key(scope))) === "online";
  }

  async getMany(scopes: readonly ComputerStatusScope[]) {
    if (scopes.length === 0) return [];
    const values = await this.redis.mget(...scopes.map((scope) => this.key(scope)));
    return values.map((value) => value === "online");
  }

  private key(scope: ComputerStatusScope) {
    return `coforge:workspace:${encodeURIComponent(scope.workspaceId)}:computer:${encodeURIComponent(scope.computerId)}:status:v1`;
  }
}

let singleton: RedisComputerStatusCache | undefined;

export function getComputerStatusCache() {
  singleton ??= new RedisComputerStatusCache(new RedisClient(redisUrlFor("Computer status")));
  return singleton;
}
