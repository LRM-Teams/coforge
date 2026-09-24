import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
  LocalAgentControlSignal,
  RedisAgentControlSignal,
} from "#src/server/agents/agent-control-signal.server";

describe("LocalAgentControlSignal", () => {
  test("notify wakes every waiter for that Agent only", async () => {
    const signal = new LocalAgentControlSignal();
    const order: string[] = [];
    const a1 = signal.wait("a", 5_000).then(() => order.push("a1"));
    const a2 = signal.wait("a", 5_000).then(() => order.push("a2"));
    const b = signal.wait("b", 50).then(() => order.push("b"));
    await signal.notify("a");
    await Promise.all([a1, a2]);
    expect(order).toEqual(["a1", "a2"]);
    await b;
    expect(order).toEqual(["a1", "a2", "b"]);
  });

  test("the fallback timeout resolves a waiter without a signal", async () => {
    const signal = new LocalAgentControlSignal();
    const started = Date.now();
    await signal.wait("a", 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    await signal.wait("a", 0);
  });
});

const redisServer = Bun.which("redis-server");
const port = 20_000 + Math.floor(Math.random() * 20_000);
const url = `redis://127.0.0.1:${port}`;
let process: ReturnType<typeof Bun.spawn> | undefined;
const clients: RedisClient[] = [];
const client = () => {
  const redis = new RedisClient(url);
  clients.push(redis);
  return redis;
};

describe.skipIf(!redisServer)("RedisAgentControlSignal", () => {
  beforeAll(async () => {
    process = Bun.spawn(
      [redisServer!, "--port", String(port), "--save", "", "--appendonly", "no"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const probe = client();
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await probe.send("PING", []);
        return;
      } catch {
        await Bun.sleep(10);
      }
    }
    throw new Error("isolated redis-server did not become ready");
  });

  afterAll(async () => {
    for (const redis of clients) redis.close();
    process?.kill();
    await process?.exited;
  });

  test("a notify on one instance wakes a waiter on another", async () => {
    const waiterSide = new RedisAgentControlSignal(client(), client);
    const notifierSide = new RedisAgentControlSignal(client(), client);
    // First wait establishes the subscription; give it a moment before publishing.
    await waiterSide.wait("warm-up", 20);
    const started = Date.now();
    const woken = waiterSide.wait("agent-a", 5_000);
    await Bun.sleep(20);
    await notifierSide.notify("agent-a");
    await woken;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("notify survives a publisher outage and the waiter falls back to its timeout", async () => {
    const broken = new RedisClient("redis://127.0.0.1:1");
    clients.push(broken);
    const signal = new RedisAgentControlSignal(broken, () => broken);
    const started = Date.now();
    await signal.notify("agent-a");
    await signal.wait("agent-a", 30);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1_000);
  });
});
