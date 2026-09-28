import { RedisClient } from "bun";
import type {
  MessageRequestIdempotency,
  MessageRequestScope,
  PersistedDirectMessage,
} from "./message-request-idempotency.server";
import { MessageRequestInProgressError } from "./message-request-idempotency.server";

const PROCESSING_TTL_SECONDS = 30;
const RESULT_TTL_SECONDS = 24 * 60 * 60;
/**
 * How often a processing claim is extended while its request is still working.
 *
 * A send handler can run far longer than `PROCESSING_TTL_SECONDS` (measured on staging: ~78s, all of
 * it after the message row exists). A claim that expires mid-flight is worse than useless: the next
 * attempt claims the same key for itself and **persists a second message**, which is exactly the
 * duplicate this layer exists to prevent. Extending the claim keeps the window honest for as long as
 * the request is alive, so a concurrent attempt is rejected instead of writing again.
 */
const PROCESSING_REFRESH_MS = 10_000;
const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;
const REFRESH_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0`;

type StoredValue =
  | { state: "processing"; owner: string }
  | {
      state: "completed";
      message: Omit<PersistedDirectMessage, "createdAt"> & {
        createdAt: string;
      };
    };

interface RedisMessageRequestCommands {
  /** A plain expiring write: the completion of a request whose row exists. */
  set(key: string, value: string, ex: "EX", seconds: number): Promise<"OK" | string | null>;
  get(key: string): Promise<string | null>;
  /**
   * The raw command surface. The claim is issued as `SET key value NX EX <ttl>` rather than through
   * the client's typed `set`, because the two flags together are not one of its documented forms —
   * and the claim is the *only* thing standing between one idempotency key and two messages, so its
   * exclusivity must not depend on how a client parses optional arguments.
   */
  send(command: string, args: string[]): Promise<unknown>;
}

/** The timer seam, so a test can drive the claim refresh without waiting on wall-clock time. */
export type MessageRequestIdempotencyTimers = Readonly<{
  schedule(run: () => void, everyMs: number): unknown;
  cancel(handle: unknown): void;
}>;

const systemTimers: MessageRequestIdempotencyTimers = {
  schedule: (run, everyMs) => {
    const handle = setInterval(run, everyMs);
    // A pending claim refresh must never keep the process alive on its own.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class RedisMessageRequestIdempotency implements MessageRequestIdempotency {
  private readonly timers: MessageRequestIdempotencyTimers;

  constructor(
    private readonly redis: RedisMessageRequestCommands,
    options: {
      timers?: MessageRequestIdempotencyTimers;
      refreshMs?: number;
    } = {},
  ) {
    this.timers = options.timers ?? systemTimers;
    this.#refreshMs = options.refreshMs ?? PROCESSING_REFRESH_MS;
  }

  readonly #refreshMs: number;

  async execute(scope: MessageRequestScope, persist: () => Promise<PersistedDirectMessage>) {
    const key = this.key(scope);
    const processing = JSON.stringify({
      state: "processing",
      owner: crypto.randomUUID(),
    });
    const claimed = await this.redis.send("SET", [
      key,
      processing,
      "NX",
      "EX",
      String(PROCESSING_TTL_SECONDS),
    ]);
    if (claimed === null) {
      const stored = await this.redis.get(key);
      if (!stored) throw new MessageRequestInProgressError();
      const value = JSON.parse(stored) as StoredValue;
      // While the first request is still working, a second one is refused outright: it must never
      // reach persistence, or one idempotency key would produce two messages.
      if (value.state === "processing") throw new MessageRequestInProgressError();
      return { ...value.message, createdAt: new Date(value.message.createdAt) };
    }

    // Keep the claim while this request works, so a long handler cannot open the window the next
    // attempt would claim and write through.
    const keepAlive = this.timers.schedule(() => {
      // Only the owner may extend its own claim, exactly as only the owner may release it.
      void this.redis
        .send("EVAL", [REFRESH_IF_OWNER, "1", key, processing, String(PROCESSING_TTL_SECONDS)])
        .catch(() => undefined);
    }, this.#refreshMs);

    try {
      const message = await persist();
      const completed = JSON.stringify({
        state: "completed",
        message: { ...message, createdAt: message.createdAt.toISOString() },
      });
      // Completion is written unconditionally, and deliberately so: the message row exists by now,
      // and failing here (an ownership check that can only fail once the claim is gone) is what made
      // a *successful* send report failure — and a failure is what the client retries. The row and
      // its result are the truth; the claim was only ever a lock.
      await this.redis.set(key, completed, "EX", RESULT_TTL_SECONDS);
      return message;
    } catch (error) {
      await this.redis.send("EVAL", [RELEASE_IF_OWNER, "1", key, processing]);
      throw error;
    } finally {
      this.timers.cancel(keepAlive);
    }
  }

  private key(scope: MessageRequestScope) {
    const segment = (value: string) => encodeURIComponent(value);
    return `coforge:message-request:v1:${segment(scope.workspaceId)}:${scope.senderKind}:${segment(scope.senderId)}:${segment(scope.requestId)}`;
  }
}

let singleton: RedisMessageRequestIdempotency | undefined;

export function getMessageRequestIdempotency() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required to send messages");
  singleton ??= new RedisMessageRequestIdempotency(new RedisClient(redisUrl));
  return singleton;
}
