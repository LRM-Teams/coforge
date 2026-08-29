import { RedisClient } from "bun";
import type {
  MessageRequestIdempotency,
  MessageRequestScope,
  PersistedDirectMessage,
} from "./message-request-idempotency.server";
import { MessageRequestInProgressError } from "./message-request-idempotency.server";

const PROCESSING_TTL_SECONDS = 30;
const RESULT_TTL_SECONDS = 24 * 60 * 60;
const COMPLETE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0`;
const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

type StoredValue =
  | { state: "processing"; owner: string }
  | {
      state: "completed";
      message: Omit<PersistedDirectMessage, "createdAt"> & { createdAt: string };
    };

interface RedisMessageRequestCommands {
  set(
    key: string,
    value: string,
    ex: "EX",
    seconds: string,
    nx: "NX",
  ): Promise<"OK" | string | null>;
  get(key: string): Promise<string | null>;
  send(command: "EVAL", args: string[]): Promise<number>;
}

export class RedisMessageRequestIdempotency implements MessageRequestIdempotency {
  constructor(private readonly redis: RedisMessageRequestCommands) {}

  async execute(scope: MessageRequestScope, persist: () => Promise<PersistedDirectMessage>) {
    const key = this.key(scope);
    const processing = JSON.stringify({ state: "processing", owner: crypto.randomUUID() });
    const claimed = await this.redis.set(
      key,
      processing,
      "EX",
      String(PROCESSING_TTL_SECONDS),
      "NX",
    );
    if (claimed === null) {
      const stored = await this.redis.get(key);
      if (!stored) throw new MessageRequestInProgressError();
      const value = JSON.parse(stored) as StoredValue;
      if (value.state === "processing") throw new MessageRequestInProgressError();
      return { ...value.message, createdAt: new Date(value.message.createdAt) };
    }

    try {
      const message = await persist();
      const completed = JSON.stringify({
        state: "completed",
        message: { ...message, createdAt: message.createdAt.toISOString() },
      });
      const owned = await this.redis.send("EVAL", [
        COMPLETE_IF_OWNER,
        "1",
        key,
        processing,
        completed,
        String(RESULT_TTL_SECONDS),
      ]);
      if (owned !== 1) throw new Error("message idempotency claim expired before completion");
      return message;
    } catch (error) {
      await this.redis.send("EVAL", [RELEASE_IF_OWNER, "1", key, processing]);
      throw error;
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
