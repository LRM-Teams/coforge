import { describe, expect, test } from "bun:test";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { MessageRequestInProgressError } from "#src/server/conversations/message-request-idempotency.server";

type Entry = { value: string; ttlSeconds: number };

class FakeRedisCommands {
  readonly entries = new Map<string, Entry>();
  readonly setCalls: Array<{ key: string; ttlSeconds: number }> = [];
  readonly evalCalls: Array<{
    operation: "refresh" | "release";
    key: string;
  }> = [];
  readonly refreshes: Array<{ key: string; owner: string; ttlSeconds: number }> = [];

  /** A plain expiring write: the completion of a request whose row already exists. */
  async set(key: string, value: string, ex: "EX", seconds: number): Promise<"OK"> {
    expect(ex).toBe("EX");
    this.entries.set(key, { value, ttlSeconds: Number(seconds) });
    return "OK" as const;
  }

  async get(key: string) {
    return this.entries.get(key)?.value ?? null;
  }

  /** The raw surface: `SET … NX EX` claims, and the two owner-checked EVALs extend and release. */
  async send(command: string, args: string[]) {
    if (command === "SET") {
      const [key, value, nx, ex, seconds] = args;
      expect(nx).toBe("NX");
      expect(ex).toBe("EX");
      const ttlSeconds = Number(seconds);
      this.setCalls.push({ key, ttlSeconds });
      if (this.entries.has(key)) return null;
      this.entries.set(key, { value, ttlSeconds });
      return "OK";
    }
    expect(command).toBe("EVAL");
    const [script, keyCount, key, owner, extra] = args;
    expect(keyCount).toBe("1");
    const refresh = script.includes("EXPIRE");
    this.evalCalls.push({ operation: refresh ? "refresh" : "release", key });
    if (this.entries.get(key)?.value !== owner) return 0;
    if (refresh) {
      this.refreshes.push({ key, owner, ttlSeconds: Number(extra) });
      this.entries.set(key, { value: owner, ttlSeconds: Number(extra) });
      return 1;
    }
    this.entries.delete(key);
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
  threadRootId: null,
  workspaceId: "workspace-a",
  agentId: "agent-a",
  attachments: [],
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
    expect(redis.evalCalls).toContainEqual({
      operation: "release",
      key: redis.setCalls[0]?.key,
    });
    expect(await idempotency.execute(scope, async () => message)).toBe(message);
  });

  test("a persist that outlives its claim still completes, so a successful send never reports failure", async () => {
    const redis = new FakeRedisCommands();
    const idempotency = new RedisMessageRequestIdempotency(redis);

    // The claim disappears while the handler works (the window a heartbeat exists to prevent): the
    // row is written, so the result must still be stored and returned rather than thrown away.
    const result = await idempotency.execute(scope, async () => {
      redis.entries.delete(redis.setCalls[0]!.key);
      return message;
    });

    expect(result).toBe(message);
    const stored = JSON.parse(redis.entries.get(redis.setCalls[0]!.key)!.value) as {
      state: string;
      message: { id: string };
    };
    expect(stored.state).toBe("completed");
    expect(stored.message.id).toBe("message-a");
  });

  test("keeps the processing claim alive while a slow handler runs, so a retry is refused not written", async () => {
    const redis = new FakeRedisCommands();
    const scheduled: Array<() => void> = [];
    const idempotency = new RedisMessageRequestIdempotency(redis, {
      refreshMs: 1_000,
      timers: {
        schedule: (run) => {
          scheduled.push(run);
          return scheduled.length;
        },
        cancel: () => {},
      },
    });
    let release: (() => void) | undefined;
    const holding = new Promise<typeof message>((resolve) => {
      release = () => resolve(message);
    });
    const first = idempotency.execute(scope, () => holding);
    await Promise.resolve();

    // The heartbeat runs while the handler is still working and only ever extends its own claim.
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await Promise.resolve();
    expect(redis.refreshes).toEqual([
      { key: redis.setCalls[0]!.key, owner: expect.any(String), ttlSeconds: 30 },
    ]);

    // A second attempt with the same key is refused and never persists.
    let persisted = false;
    await expect(
      idempotency.execute(scope, async () => {
        persisted = true;
        return message;
      }),
    ).rejects.toBeInstanceOf(MessageRequestInProgressError);
    expect(persisted).toBeFalse();

    release!();
    expect(await first).toBe(message);
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
