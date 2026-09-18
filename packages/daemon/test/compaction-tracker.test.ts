import { afterEach, expect, jest, test } from "bun:test";
import { CompactionTracker, COMPACTION_STALE_MS } from "../src/agent-runtime/compaction-tracker";

afterEach(() => jest.useRealTimers());

test("start reports started, and a repeated start while active is deduped", () => {
  const tracker = new CompactionTracker(() => {});
  expect(tracker.start("agent-a")).toBe("started");
  expect(tracker.isActive("agent-a")).toBe(true);
  expect(tracker.start("agent-a")).toBe("already-active");
});

test("finish reports finished only when a compaction is active, and is idempotent after", () => {
  const tracker = new CompactionTracker(() => {});
  expect(tracker.finish("agent-a")).toBe("not-active");
  tracker.start("agent-a");
  expect(tracker.finish("agent-a")).toBe("finished");
  expect(tracker.isActive("agent-a")).toBe(false);
  expect(tracker.finish("agent-a")).toBe("not-active");
});

test("interrupt silently clears an active compaction, and finish afterward is a no-op", () => {
  const tracker = new CompactionTracker(() => {});
  tracker.start("agent-a");
  tracker.interrupt("agent-a");
  expect(tracker.isActive("agent-a")).toBe(false);
  expect(tracker.finish("agent-a")).toBe("not-active");
});

test("interrupt on an Agent with no active compaction is a no-op", () => {
  const tracker = new CompactionTracker(() => {});
  expect(() => tracker.interrupt("agent-a")).not.toThrow();
  expect(tracker.isActive("agent-a")).toBe(false);
});

test("watchdog fires onStale once, COMPACTION_STALE_MS after start, while still active", () => {
  const stale: string[] = [];
  const tracker = new CompactionTracker((agentId) => stale.push(agentId));
  jest.useFakeTimers();
  tracker.start("agent-a");
  jest.advanceTimersByTime(COMPACTION_STALE_MS - 1);
  expect(stale).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(stale).toEqual(["agent-a"]);
  // One-shot: it stays active, but does not re-arm for the same episode.
  expect(tracker.isActive("agent-a")).toBe(true);
  jest.advanceTimersByTime(COMPACTION_STALE_MS * 10);
  expect(stale).toEqual(["agent-a"]);
});

test("finish before the watchdog fires clears the timer without calling onStale", () => {
  const stale: string[] = [];
  const tracker = new CompactionTracker((agentId) => stale.push(agentId));
  jest.useFakeTimers();
  tracker.start("agent-a");
  expect(jest.getTimerCount()).toBeGreaterThan(0);
  tracker.finish("agent-a");
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(COMPACTION_STALE_MS);
  expect(stale).toEqual([]);
});

test("interrupt before the watchdog fires clears the timer without calling onStale", () => {
  const stale: string[] = [];
  const tracker = new CompactionTracker((agentId) => stale.push(agentId));
  jest.useFakeTimers();
  tracker.start("agent-a");
  tracker.interrupt("agent-a");
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(COMPACTION_STALE_MS);
  expect(stale).toEqual([]);
});

test("dispose clears a pending watchdog and forgets the Agent, leaking no timer", () => {
  const stale: string[] = [];
  const tracker = new CompactionTracker((agentId) => stale.push(agentId));
  jest.useFakeTimers();
  tracker.start("agent-a");
  expect(jest.getTimerCount()).toBeGreaterThan(0);
  tracker.dispose("agent-a");
  expect(jest.getTimerCount()).toBe(0);
  expect(tracker.isActive("agent-a")).toBe(false);
  jest.advanceTimersByTime(COMPACTION_STALE_MS);
  expect(stale).toEqual([]);
  // A later launch for the same Agent starts clean.
  expect(tracker.start("agent-a")).toBe("started");
});

test("dispose on an Agent with no state is a no-op", () => {
  const tracker = new CompactionTracker(() => {});
  expect(() => tracker.dispose("agent-unknown")).not.toThrow();
});

test("disposeAll clears every tracked Agent's watchdog", () => {
  const stale: string[] = [];
  const tracker = new CompactionTracker((agentId) => stale.push(agentId));
  jest.useFakeTimers();
  tracker.start("agent-a");
  tracker.start("agent-b");
  expect(jest.getTimerCount()).toBeGreaterThan(0);
  tracker.disposeAll();
  expect(jest.getTimerCount()).toBe(0);
  expect(tracker.isActive("agent-a")).toBe(false);
  expect(tracker.isActive("agent-b")).toBe(false);
  jest.advanceTimersByTime(COMPACTION_STALE_MS);
  expect(stale).toEqual([]);
});

test("a stale watchdog from a previous, already-finished episode does not fire against a new one", () => {
  const stale: string[] = [];
  const tracker = new CompactionTracker((agentId) => stale.push(agentId));
  jest.useFakeTimers();
  tracker.start("agent-a");
  jest.advanceTimersByTime(COMPACTION_STALE_MS - 1);
  tracker.finish("agent-a");
  tracker.start("agent-a"); // a fresh episode, with its own watchdog
  jest.advanceTimersByTime(1);
  // The old watchdog's deadline has passed, but it was cleared by finish(); only the new
  // episode's watchdog (freshly armed) is still pending.
  expect(stale).toEqual([]);
  jest.advanceTimersByTime(COMPACTION_STALE_MS - 1);
  expect(stale).toEqual(["agent-a"]);
});

test("each Agent's compaction state is independent", () => {
  const tracker = new CompactionTracker(() => {});
  tracker.start("agent-a");
  expect(tracker.isActive("agent-a")).toBe(true);
  expect(tracker.isActive("agent-b")).toBe(false);
  expect(tracker.finish("agent-b")).toBe("not-active");
});
