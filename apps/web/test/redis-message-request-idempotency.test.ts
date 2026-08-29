import { describe, expect, test } from "bun:test";
import { RedisMessageRequestIdempotency } from "../src/server/conversations/redis-message-request-idempotency.server";
import { MessageRequestInProgressError } from "../src/server/conversations/message-request-idempotency.server";

type Entry = { value: string; ttlSeconds: number };

class FakeRedisCommands {
  readonly entries = new Map<string, Entry>();
  readonly setCalls: Array<{ key: string; ttlSeconds: number }> = [];
  readonly evalCalls: Array<{ operation: "complete" | "release"; key: string }> = [];

  async set(key: string, value: string, ex: "EX", seconds: string, nx: "NX") {
    expect(ex).toBe("EX");
    expect(nx).toBe("NX");
    const ttlSeconds = Number(seconds);
    this.setCalls.push({ key, ttlSeconds });
    if (this.entries.has(key)) return null;
    this.entries.set(key, { value, ttlSeconds });
    return "OK" as const;
  }

  async get(key: string) {
    return this.entries.get(key)?.value ?? null;
  }

  async send(command: string, args: string[]) {
    expect(command).toBe("EVAL");
    const [script, keyCount, key, owner, completed, ttl] = args;
    expect(keyCount).toBe("1");
    const operation = script.includes('redis.call("SET"') ? "complete" : "release";
    this.evalCalls.push({ operation, key });
    if (this.entries.get(key)?.value !== owner) return 0;
    if (operation === "complete") {
      this.entries.set(key, { value: completed, ttlSeconds: Number(ttl) });
    } else {
      this.entries.delete(key);
    }
    return 1;
  }
}

const scope = {
  workspaceId: "workspace-a",
  senderKind: "user" as const,
  senderId: "sender-a",
  requestId: "request-a",
};
const message = {
  id: "message-a",
  body: "hello",
  createdAt: new Date("2026-08-29T12:00:00.000Z"),
  sequence: 1,
  workspaceId: "workspace-a",
  agentId: "agent-a",
};

describe("RedisMessageRequestIdempotency", () => {
  test("claims once, caches completed results for 24 hours, and restores Date values", async () => {
    const redis = new FakeRedisCommands();
    const idempotency = new RedisMessageRequestIdempotency(redis);
    let persistCalls = 0;
    const persist = async () => {
      persistCalls++;
      return message;
    };

    expect(await idempotency.execute(scope, persist)).toBe(message);
    const recovered = await idempotency.execute(scope, persist);

    expect(persistCalls).toBe(1);
    expect(recovered).toEqual(message);
    expect(recovered.createdAt).toBeInstanceOf(Date);
    expect(redis.setCalls[0]?.ttlSeconds).toBe(30);
    expect(redis.entries.values().next().value?.ttlSeconds).toBe(86_400);
  });

  test("rejects an existing processing claim without persisting", async () => {
    const redis = new FakeRedisCommands();
    const idempotency = new RedisMessageRequestIdempotency(redis);
    const pending = new Promise<typeof message>(() => {});
    void idempotency.execute(scope, () => pending);
    await Promise.resolve();
    let persisted = false;

    await expect(
      idempotency.execute(scope, async () => {
        persisted = true;
        return message;
      }),
    ).rejects.toBeInstanceOf(MessageRequestInProgressError);
    expect(persisted).toBeFalse();
  });

  test("owner-checks release after persistence failure so the request can retry", async () => {
    const redis = new FakeRedisCommands();
    const idempotency = new RedisMessageRequestIdempotency(redis);
    const failure = new Error("database unavailable");

    await expect(
      idempotency.execute(scope, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(redis.evalCalls).toContainEqual({ operation: "release", key: redis.setCalls[0]?.key });
    expect(await idempotency.execute(scope, async () => message)).toBe(message);
  });

  test("fails completion when claim ownership was lost and preserves the newer value", async () => {
    const redis = new FakeRedisCommands();
    const idempotency = new RedisMessageRequestIdempotency(redis);
    const replacement = JSON.stringify({ state: "processing", owner: "new-owner" });

    await expect(
      idempotency.execute(scope, async () => {
        const key = redis.setCalls[0]!.key;
        redis.entries.set(key, { value: replacement, ttlSeconds: 30 });
        return message;
      }),
    ).rejects.toThrow("claim expired before completion");
    expect(redis.entries.get(redis.setCalls[0]!.key)?.value).toBe(replacement);
  });

  test("uses every scope field to distinguish Redis keys", async () => {
    const redis = new FakeRedisCommands();
    const idempotency = new RedisMessageRequestIdempotency(redis);
    const scopes = [
      scope,
      { ...scope, workspaceId: "workspace-b" },
      { ...scope, senderKind: "agent" as const },
      { ...scope, senderId: "sender-b" },
      { ...scope, requestId: "request-b" },
    ];

    for (const candidate of scopes) await idempotency.execute(candidate, async () => message);

    expect(new Set(redis.setCalls.map(({ key }) => key)).size).toBe(scopes.length);
  });
});
