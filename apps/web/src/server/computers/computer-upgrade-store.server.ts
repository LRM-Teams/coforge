import { RedisClient } from "bun";

export type ComputerUpgradeStatus =
  | { requestId: string; status: "accepted"; expectedVersion: string; expiresAt: string }
  | {
      requestId: string;
      status: "completed";
      expectedVersion: string;
      computerVersion: string;
      daemonVersion: string;
      workerInstanceId: string;
      completedAt: string;
    }
  | { requestId: string; status: "failed"; reason: "timeout" | "publication" | "evidence" }
  | { requestId: string; status: "unknown"; reason: "corrupt" };

type Scope = { workspaceId: string; computerId: string };
type Identity = {
  workerInstanceId: string;
  computerVersion: string;
  daemonVersion: string;
  startedAt: number;
};
type Stored = ComputerUpgradeStatus & { previousWorkerInstanceId?: string };
const TTL = 10 * 60;
const REPLACE = `if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 end return 0`;
const STORE_NEWER_IDENTITY = `
local current = redis.call("GET", KEYS[1])
local candidate = cjson.decode(ARGV[1])
if current then
  local previous = cjson.decode(current)
  if previous.startedAt > candidate.startedAt or
     (previous.startedAt == candidate.startedAt and previous.workerInstanceId ~= candidate.workerInstanceId) then
    return 0
  end
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return 1`;
const COMMIT_READY = `
local current = redis.call("GET", KEYS[1])
local identity = redis.call("GET", KEYS[2])
local candidate = cjson.decode(ARGV[2])
if identity then
  local previous = cjson.decode(identity)
  if previous.startedAt > candidate.startedAt or
     (previous.startedAt == candidate.startedAt and previous.workerInstanceId ~= candidate.workerInstanceId) then
    return 0
  end
end
if current ~= ARGV[1] or cjson.decode(current).status ~= "accepted" then return 0 end
redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[4])
redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[4])
return 1`;

export class RedisComputerUpgradeStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(...args: string[]): Promise<unknown>;
      send(command: "EVAL", args: string[]): Promise<unknown>;
    },
    private readonly now = Date.now,
  ) {}
  async identity(scope: Scope): Promise<Identity | undefined> {
    return this.parseIdentity(await this.redis.get(this.identityKey(scope)));
  }
  async begin(scope: Scope, requestId: string, expectedVersion: string) {
    const existingRaw = await this.redis.get(this.requestKey(scope, requestId));
    const existing = existingRaw ? this.parse(existingRaw) : undefined;
    if (existing) return { status: this.public(existing), created: false };
    const current = await this.identity(scope);
    if (!current) throw new Error("Computer process identity is unavailable");
    const record: Stored = {
      requestId,
      status: "accepted",
      expectedVersion,
      expiresAt: new Date(this.now() + TTL * 1000).toISOString(),
      previousWorkerInstanceId: current.workerInstanceId,
    };
    const result = await this.redis.set(
      this.requestKey(scope, requestId),
      JSON.stringify(record),
      "EX",
      String(TTL),
      "NX",
    );
    if (result === null) {
      const racedRaw = await this.redis.get(this.requestKey(scope, requestId));
      const raced = racedRaw ? this.parse(racedRaw) : undefined;
      if (raced) return { status: this.public(raced), created: false };
      throw new Error("upgrade request could not be registered");
    }
    return { status: this.public(record), created: true };
  }
  async publicationFailed(scope: Scope, requestId: string) {
    await this.replaceAccepted(scope, requestId, {
      requestId,
      status: "failed",
      reason: "publication",
    });
  }
  async status(scope: Scope, requestId: string): Promise<ComputerUpgradeStatus | undefined> {
    const raw = await this.redis.get(this.requestKey(scope, requestId));
    if (!raw) return undefined;
    const current = this.parse(raw);
    if (!current) return { requestId, status: "unknown", reason: "corrupt" };
    if (current.status === "accepted" && Date.parse(current.expiresAt) <= this.now()) {
      const failed = { requestId, status: "failed" as const, reason: "timeout" as const };
      if (await this.replace(scope, requestId, failed)) return failed;
    }
    return this.public(current);
  }
  async ready(scope: Scope, identity: Identity, recoveredIds: readonly string[]) {
    for (const requestId of recoveredIds) {
      const raw = await this.redis.get(this.requestKey(scope, requestId));
      const current = raw ? this.parse(raw) : undefined;
      if (
        raw &&
        current?.status === "accepted" &&
        current.previousWorkerInstanceId !== identity.workerInstanceId &&
        current.expectedVersion === identity.computerVersion &&
        identity.computerVersion === identity.daemonVersion
      )
        await this.commitReady(scope, requestId, raw, identity, {
          requestId,
          status: "completed",
          expectedVersion: current.expectedVersion,
          ...identity,
          completedAt: new Date(this.now()).toISOString(),
        });
      else if (current?.status === "accepted" && raw)
        await this.replace(scope, requestId, { requestId, status: "failed", reason: "evidence" });
    }
    await this.redis.send("EVAL", [
      STORE_NEWER_IDENTITY,
      "1",
      this.identityKey(scope),
      JSON.stringify(identity),
      String(TTL),
    ]);
  }
  private async replace(scope: Scope, requestId: string, record: Stored) {
    const current = await this.redis.get(this.requestKey(scope, requestId));
    return current
      ? (await this.redis.send("EVAL", [
          REPLACE,
          "1",
          this.requestKey(scope, requestId),
          current,
          JSON.stringify(record),
          String(TTL),
        ])) === 1
      : false;
  }
  private async replaceAccepted(scope: Scope, requestId: string, record: Stored) {
    const current = await this.redis.get(this.requestKey(scope, requestId));
    if (!current || this.parse(current)?.status !== "accepted") return false;
    return (
      (await this.redis.send("EVAL", [
        `if redis.call("GET", KEYS[1]) == ARGV[1] and cjson.decode(ARGV[1]).status == "accepted" then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 end return 0`,
        "1",
        this.requestKey(scope, requestId),
        current,
        JSON.stringify(record),
        String(TTL),
      ])) === 1
    );
  }
  private async commitReady(
    scope: Scope,
    requestId: string,
    current: string,
    identity: Identity,
    record: Stored,
  ) {
    return (
      (await this.redis.send("EVAL", [
        COMMIT_READY,
        "2",
        this.requestKey(scope, requestId),
        this.identityKey(scope),
        current,
        JSON.stringify(identity),
        JSON.stringify(record),
        String(TTL),
      ])) === 1
    );
  }
  private public({ previousWorkerInstanceId: _private, ...value }: Stored) {
    return value;
  }
  private parse(raw: string): Stored | undefined {
    try {
      const value = JSON.parse(raw) as Stored;
      if (typeof value?.requestId !== "string" || value.requestId.length === 0) return undefined;
      if (value.status === "accepted")
        return typeof value.expectedVersion === "string" &&
          value.expectedVersion.length > 0 &&
          typeof value.expiresAt === "string" &&
          Number.isFinite(Date.parse(value.expiresAt)) &&
          typeof value.previousWorkerInstanceId === "string" &&
          value.previousWorkerInstanceId.length > 0
          ? value
          : undefined;
      if (value.status === "completed")
        return typeof value.expectedVersion === "string" &&
          value.expectedVersion.length > 0 &&
          typeof value.computerVersion === "string" &&
          value.computerVersion.length > 0 &&
          typeof value.daemonVersion === "string" &&
          value.daemonVersion.length > 0 &&
          typeof value.workerInstanceId === "string" &&
          value.workerInstanceId.length > 0 &&
          typeof value.completedAt === "string" &&
          Number.isFinite(Date.parse(value.completedAt))
          ? value
          : undefined;
      if (value.status === "failed")
        return value.reason === "timeout" ||
          value.reason === "publication" ||
          value.reason === "evidence"
          ? value
          : undefined;
      return value.status === "unknown" && value.reason === "corrupt" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  private parseIdentity(raw: string | null): Identity | undefined {
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Identity;
      return typeof value.workerInstanceId === "string" &&
        value.workerInstanceId.length > 0 &&
        typeof value.computerVersion === "string" &&
        value.computerVersion.length > 0 &&
        typeof value.daemonVersion === "string" &&
        value.daemonVersion.length > 0 &&
        Number.isSafeInteger(value.startedAt) &&
        value.startedAt >= 0
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }
  private scope(scope: Scope) {
    return `coforge:workspace:${encodeURIComponent(scope.workspaceId)}:computer:${encodeURIComponent(scope.computerId)}:upgrade:v1`;
  }
  private identityKey(scope: Scope) {
    return `${this.scope(scope)}:identity`;
  }
  private requestKey(scope: Scope, requestId: string) {
    return `${this.scope(scope)}:request:${encodeURIComponent(requestId)}`;
  }
}

let singleton: RedisComputerUpgradeStore | undefined;
export function getComputerUpgradeStore() {
  const url = Bun.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for Computer upgrade status");
  singleton ??= new RedisComputerUpgradeStore(new RedisClient(url));
  return singleton;
}
