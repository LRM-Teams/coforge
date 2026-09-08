import { RedisClient } from "bun";
import type { ComputerRestartStatus } from "../../features/computers/computer.schemas";

const RESTART_TIMEOUT_MS = 60_000;
const RESTART_TTL_SECONDS = 5 * 60;
const REPLACE_IF_CURRENT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0`;
const STORE_NEWER_IDENTITY = `
local current = redis.call("GET", KEYS[1])
if not current then
  redis.call("SET", KEYS[1], ARGV[1])
  return 1
end
local ok, identity = pcall(cjson.decode, current)
local candidate = cjson.decode(ARGV[1])
if not ok or type(identity.startedAt) ~= "number" or candidate.startedAt > identity.startedAt then
  redis.call("SET", KEYS[1], ARGV[1])
  return 1
end
return 0`;

export type ComputerProcessIdentity = {
  workerInstanceId: string;
  daemonVersion: string;
  startedAt: number;
};

type Scope = { workspaceId: string; computerId: string };
type StoredRestart = ComputerRestartStatus & { previousWorkerInstanceId?: string };

export interface ComputerRestartStore {
  identity?(scope: Scope): Promise<ComputerProcessIdentity | undefined>;
  begin(
    scope: Scope,
    requestId: string,
  ): Promise<{ status: ComputerRestartStatus; created: boolean }>;
  publicationFailed(scope: Scope, requestId: string): Promise<void>;
  status(scope: Scope, requestId: string): Promise<ComputerRestartStatus | undefined>;
  ready(
    scope: Scope,
    identity: ComputerProcessIdentity,
    recoveredRequestIds: readonly string[],
  ): Promise<void>;
}

export class RedisComputerRestartStore implements ComputerRestartStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(...args: string[]): Promise<unknown>;
      send(command: "EVAL", args: string[]): Promise<unknown>;
    },
    private readonly now = Date.now,
  ) {}

  async identity(scope: Scope): Promise<ComputerProcessIdentity | undefined> {
    return this.parseIdentity(await this.redis.get(this.identityKey(scope)));
  }

  async begin(scope: Scope, requestId: string) {
    const key = this.requestKey(scope, requestId);
    const existing = this.parseRestart(await this.redis.get(key));
    if (existing) return { status: this.publicStatus(existing), created: false };
    const current = this.parseIdentity(await this.redis.get(this.identityKey(scope)));
    if (!current) throw new Error("Computer process identity is unavailable");
    const record: StoredRestart = {
      requestId,
      status: "accepted",
      expiresAt: new Date(this.now() + RESTART_TIMEOUT_MS).toISOString(),
      previousWorkerInstanceId: current.workerInstanceId,
    };
    const result = await this.redis.set(
      key,
      JSON.stringify(record),
      "EX",
      String(RESTART_TTL_SECONDS),
      "NX",
    );
    if (result === null) {
      const raced = this.parseRestart(await this.redis.get(key));
      if (raced) return { status: this.publicStatus(raced), created: false };
      throw new Error("Restart request could not be registered");
    }
    return { status: this.publicStatus(record), created: true };
  }

  async publicationFailed(scope: Scope, requestId: string) {
    const currentValue = await this.redis.get(this.requestKey(scope, requestId));
    const current = this.parseRestart(currentValue);
    if (!currentValue || !current || current.status !== "accepted") return;
    await this.replaceRestart(scope, currentValue, {
      requestId,
      status: "failed",
      reason: "publication",
    });
  }

  async status(scope: Scope, requestId: string) {
    const currentValue = await this.redis.get(this.requestKey(scope, requestId));
    const current = this.parseRestart(currentValue);
    if (!currentValue || !current) return undefined;
    if (current.status === "accepted" && Date.parse(current.expiresAt) <= this.now()) {
      const failed = { requestId, status: "failed" as const, reason: "timeout" as const };
      const replaced = await this.replaceRestart(scope, currentValue, failed);
      if (replaced) return failed;
      const raced = this.parseRestart(await this.redis.get(this.requestKey(scope, requestId)));
      return raced ? this.publicStatus(raced) : undefined;
    }
    return this.publicStatus(current);
  }

  async ready(
    scope: Scope,
    identity: ComputerProcessIdentity,
    recoveredRequestIds: readonly string[],
  ) {
    for (const requestId of recoveredRequestIds) {
      const currentValue = await this.redis.get(this.requestKey(scope, requestId));
      const current = this.parseRestart(currentValue);
      if (
        currentValue &&
        current?.status === "accepted" &&
        current.previousWorkerInstanceId &&
        current.previousWorkerInstanceId !== identity.workerInstanceId &&
        Date.parse(current.expiresAt) > this.now()
      ) {
        await this.replaceRestart(scope, currentValue, {
          requestId,
          status: "completed",
          completedAt: new Date(this.now()).toISOString(),
          ...identity,
        });
      }
    }
    await this.redis.send("EVAL", [
      STORE_NEWER_IDENTITY,
      "1",
      this.identityKey(scope),
      JSON.stringify(identity),
    ]);
  }

  private async replaceRestart(scope: Scope, current: string, record: StoredRestart) {
    return (
      (await this.redis.send("EVAL", [
        REPLACE_IF_CURRENT,
        "1",
        this.requestKey(scope, record.requestId),
        current,
        JSON.stringify(record),
        String(RESTART_TTL_SECONDS),
      ])) === 1
    );
  }

  private publicStatus({ previousWorkerInstanceId: _private, ...status }: StoredRestart) {
    return status as ComputerRestartStatus;
  }

  private parseRestart(value: string | null): StoredRestart | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as StoredRestart;
    } catch {
      return undefined;
    }
  }

  private parseIdentity(value: string | null): ComputerProcessIdentity | undefined {
    if (!value) return undefined;
    try {
      const identity = JSON.parse(value) as ComputerProcessIdentity;
      return identity.workerInstanceId &&
        identity.daemonVersion &&
        Number.isSafeInteger(identity.startedAt)
        ? identity
        : undefined;
    } catch {
      return undefined;
    }
  }

  private identityKey(scope: Scope) {
    return `${this.scopeKey(scope)}:identity`;
  }
  private requestKey(scope: Scope, requestId: string) {
    return `${this.scopeKey(scope)}:request:${encodeURIComponent(requestId)}`;
  }
  private scopeKey(scope: Scope) {
    return `coforge:computer-restart:v1:${encodeURIComponent(scope.workspaceId)}:${encodeURIComponent(scope.computerId)}`;
  }
}

let singleton: ComputerRestartStore | undefined;
export function getComputerRestartStore() {
  const url = Bun.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for Computer restart status");
  singleton ??= new RedisComputerRestartStore(new RedisClient(url));
  return singleton;
}
