import { RedisClient } from "bun";
import { DAEMON_SHUTDOWN_REASONS, type DaemonShutdownReason } from "@lrm/coforge-sdk/internal";

import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

type Scope = { workspaceId: string; computerId: string };

/**
 * What the server remembers between a Workspace daemon going down and the next one being ready:
 * why the last one went down on purpose, and which daemon instance's return was last announced.
 */
export interface ComputerLifecycleMemory {
  rememberShutdown(scope: Scope, reason: DaemonShutdownReason): Promise<void>;
  /** Returns the remembered reason and forgets it. */
  takeShutdown(scope: Scope): Promise<DaemonShutdownReason | undefined>;
  /** Claims the announcement of this daemon instance's return. `first` is false for every later
   * ready of the same instance (a reconnect, a retried ready). */
  claimReturn(
    scope: Scope,
    instance: { workerInstanceId: string; computerVersion?: string },
  ): Promise<{ first: boolean; previousComputerVersion?: string }>;
}

/** Long enough to cover an upgrade's download and restart; a later ready is not its return. */
const SHUTDOWN_TTL_SECONDS = String(30 * 60);
/** How long the last announced instance is kept; a Computer away longer comes back as started. */
const RETURN_TTL_SECONDS = String(30 * 24 * 60 * 60);

export class RedisComputerLifecycleMemory implements ComputerLifecycleMemory {
  constructor(
    private readonly redis: { send(command: "SET" | "GETDEL", args: string[]): Promise<unknown> },
  ) {}

  async rememberShutdown(scope: Scope, reason: DaemonShutdownReason) {
    await this.redis.send("SET", [this.key(scope, "shutdown"), reason, "EX", SHUTDOWN_TTL_SECONDS]);
  }

  async takeShutdown(scope: Scope) {
    const value = await this.redis.send("GETDEL", [this.key(scope, "shutdown")]);
    return DAEMON_SHUTDOWN_REASONS.find((reason) => reason === value);
  }

  async claimReturn(
    scope: Scope,
    instance: { workerInstanceId: string; computerVersion?: string },
  ) {
    // `SET … GET` swaps atomically, so of two concurrent readies of one instance only one sees
    // another instance (or none) before it.
    const previous = parseInstance(
      await this.redis.send("SET", [
        this.key(scope, "return"),
        JSON.stringify(instance),
        "EX",
        RETURN_TTL_SECONDS,
        "GET",
      ]),
    );
    if (previous?.workerInstanceId === instance.workerInstanceId) return { first: false };
    return previous?.computerVersion
      ? { first: true, previousComputerVersion: previous.computerVersion }
      : { first: true };
  }

  private key(scope: Scope, name: "shutdown" | "return") {
    return workspaceRedisKey({ ...scope, name, version: "v1" });
  }
}

function parseInstance(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const workerInstanceId = Reflect.get(parsed, "workerInstanceId");
    const computerVersion = Reflect.get(parsed, "computerVersion");
    return typeof workerInstanceId === "string"
      ? {
          workerInstanceId,
          ...(typeof computerVersion === "string" ? { computerVersion } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

let memory: RedisComputerLifecycleMemory | undefined;

export function getComputerLifecycleMemory() {
  memory ??= new RedisComputerLifecycleMemory(new RedisClient(redisUrlFor("Computer lifecycle")));
  return memory;
}
