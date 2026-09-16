import { RedisClient } from "bun";
import { sanitizeUpgradeErrorText } from "@lrm/coforge-sdk/internal";
import { AppError } from "@/lib/app-error";
import { COMPUTER_STATUS_LEASE_MS } from "../centrifugo/computer-status.server";

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
  | {
      requestId: string;
      status: "failed";
      /** "reported" is the Computer's own terminal receipt; the others are server inferences. */
      reason: "timeout" | "publication" | "evidence" | "reported";
      error?: string;
    }
  | { requestId: string; status: "unknown"; reason: "corrupt" };

type Scope = { workspaceId: string; computerId: string };
/** One Computer upgrade operation's terminal receipt, as the Daemon reported it. */
export type ReportedComputerUpgradeResult = {
  requestId: string;
  status: "succeeded" | "failed";
  version?: string;
  error?: string;
  completedAtMs: number;
};
type Identity = {
  workerInstanceId: string;
  computerVersion: string;
  daemonVersion: string;
  startedAt: number;
};
type Stored = ComputerUpgradeStatus & { previousWorkerInstanceId?: string };
/** How long an upgrade request record survives - long enough to poll a Computer to completion. */
const REQUEST_TTL = 10 * 60;
/**
 * How long the Computer's process identity survives without a fresh signal. Aligned with the
 * Computer presence lease (3x the Daemon's periodic status interval) so "identity present" tracks
 * "Computer online", rather than the unrelated 10-minute request TTL: a Computer connected longer
 * than that lease used to lose its identity and fail every subsequent upgrade with an opaque
 * internal error even though it was still online.
 */
const IDENTITY_TTL = COMPUTER_STATUS_LEASE_MS / 1000;
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
redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[5])
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
    if (!current) throw new AppError("COMPUTER_OFFLINE");
    const record: Stored = {
      requestId,
      status: "accepted",
      expectedVersion,
      expiresAt: new Date(this.now() + REQUEST_TTL * 1000).toISOString(),
      previousWorkerInstanceId: current.workerInstanceId,
    };
    const result = await this.redis.set(
      this.requestKey(scope, requestId),
      JSON.stringify(record),
      "EX",
      String(REQUEST_TTL),
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
  /**
   * Accepts the Daemon's terminal report for one operation. A reported failure is authoritative:
   * only the Computer can observe it, and without it a local failure is indistinguishable from a
   * Computer that has not reconnected yet. A reported success is never sufficient on its own -
   * the Computer must still come back with an identity that proves the new version is running -
   * so it only completes a request whose identity evidence already agrees.
   */
  async reported(scope: Scope, result: ReportedComputerUpgradeResult): Promise<void> {
    const raw = await this.redis.get(this.requestKey(scope, requestId(result)));
    const current = raw ? this.parse(raw) : undefined;
    // A settled request is never reopened by a late or contradictory report.
    if (!raw || current?.status !== "accepted") return;
    if (result.status === "failed") {
      await this.replaceAccepted(scope, result.requestId, {
        requestId: result.requestId,
        status: "failed",
        reason: "reported",
        ...(result.error ? { error: sanitizeUpgradeErrorText(result.error) } : {}),
      });
      return;
    }
    if (result.version && result.version !== current.expectedVersion) return;
    const identity = await this.identity(scope);
    if (
      !identity ||
      current.previousWorkerInstanceId === identity.workerInstanceId ||
      current.expectedVersion !== identity.computerVersion ||
      identity.computerVersion !== identity.daemonVersion
    )
      return;
    await this.commitReady(scope, result.requestId, raw, identity, {
      requestId: result.requestId,
      status: "completed",
      expectedVersion: current.expectedVersion,
      ...identity,
      completedAt: new Date(this.now()).toISOString(),
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
    await this.storeNewerIdentity(scope, identity);
  }
  /**
   * Renews the identity lease on every accepted periodic Computer status, so a Computer that
   * stays connected does not silently lose its identity between Daemon reconnects (which are the
   * only other writer). The periodic status carries no identity fields of its own, so this
   * re-submits whatever is currently stored through the same monotonic guard `ready` uses -
   * a concurrent `ready()` reporting a genuinely newer identity is never clobbered by a stale
   * renewal that read the identity a moment earlier.
   */
  async touchIdentity(scope: Scope): Promise<void> {
    const raw = await this.redis.get(this.identityKey(scope));
    if (!raw || !this.parseIdentity(raw)) return;
    await this.redis.send("EVAL", [
      STORE_NEWER_IDENTITY,
      "1",
      this.identityKey(scope),
      raw,
      String(IDENTITY_TTL),
    ]);
  }
  private async storeNewerIdentity(scope: Scope, identity: Identity) {
    await this.redis.send("EVAL", [
      STORE_NEWER_IDENTITY,
      "1",
      this.identityKey(scope),
      JSON.stringify(identity),
      String(IDENTITY_TTL),
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
          String(REQUEST_TTL),
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
        String(REQUEST_TTL),
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
        String(IDENTITY_TTL),
        String(REQUEST_TTL),
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
        return (value.reason === "timeout" ||
          value.reason === "publication" ||
          value.reason === "evidence" ||
          value.reason === "reported") &&
          (value.error === undefined || typeof value.error === "string")
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

function requestId(result: ReportedComputerUpgradeResult): string {
  if (!result.requestId) throw new Error("Computer upgrade result has no request");
  return result.requestId;
}

let singleton: RedisComputerUpgradeStore | undefined;
export function getComputerUpgradeStore() {
  const url = Bun.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for Computer upgrade status");
  singleton ??= new RedisComputerUpgradeStore(new RedisClient(url));
  return singleton;
}
