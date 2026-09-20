import { expect, test } from "bun:test";
import {
  RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO,
  RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD,
  runtimeErrorDeliveryBackoffDelayMs,
  RuntimeErrorDeliveryBackoff,
  RuntimeErrorFingerprintFence,
  runtimeErrorFingerprintFenceDetail,
} from "../src/agent-runtime/runtime-error-recovery";

test("the first backoff delay is the base delay, with no jitter added when the random source returns 0", () => {
  const delay = runtimeErrorDeliveryBackoffDelayMs(1, { jitterRandom: () => 0 });
  expect(delay).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
});

test("the delay doubles with each attempt", () => {
  expect(runtimeErrorDeliveryBackoffDelayMs(2, { jitterRandom: () => 0 })).toBe(
    RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * 2,
  );
  expect(runtimeErrorDeliveryBackoffDelayMs(3, { jitterRandom: () => 0 })).toBe(
    RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * 4,
  );
});

test("the delay is capped at the maximum even for a very high attempt count", () => {
  const delay = runtimeErrorDeliveryBackoffDelayMs(20, { jitterRandom: () => 0 });
  expect(delay).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS);
});

test("jitter adds up to the configured ratio of the capped delay, from an injectable source", () => {
  const withFullJitter = runtimeErrorDeliveryBackoffDelayMs(1, { jitterRandom: () => 1 });
  expect(withFullJitter).toBe(
    Math.floor(
      RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * (1 + RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO),
    ),
  );
  const withHalfJitter = runtimeErrorDeliveryBackoffDelayMs(1, { jitterRandom: () => 0.5 });
  expect(withHalfJitter).toBeGreaterThan(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
  expect(withHalfJitter).toBeLessThan(withFullJitter);
});

test("jitter never pushes the delay above the configured maximum", () => {
  const delay = runtimeErrorDeliveryBackoffDelayMs(20, { jitterRandom: () => 1 });
  expect(delay).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS);
});

test("RuntimeErrorDeliveryBackoff.recordFailure counts attempts and computes an increasing until-time", () => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 0 });
  const now = 1_000_000;
  const first = backoff.recordFailure("agent-1", now);
  expect(first.attempts).toBe(1);
  expect(first.delayMs).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
  expect(first.untilMs).toBe(now + RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
  const second = backoff.recordFailure("agent-1", now);
  expect(second.attempts).toBe(2);
  expect(second.delayMs).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * 2);
});

test("RuntimeErrorDeliveryBackoff.reset clears the streak and reports how many failures were cleared", () => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 0 });
  backoff.recordFailure("agent-1");
  backoff.recordFailure("agent-1");
  expect(backoff.reset("agent-1")).toBe(2);
  expect(backoff.attempts("agent-1")).toBe(0);
  // A fresh failure after reset starts back at the base delay.
  const after = backoff.recordFailure("agent-1", 0);
  expect(after.attempts).toBe(1);
  expect(after.delayMs).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
});

test("RuntimeErrorDeliveryBackoff tracks each Agent independently", () => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 0 });
  backoff.recordFailure("agent-1");
  backoff.recordFailure("agent-1");
  expect(backoff.attempts("agent-2")).toBe(0);
});

test("a fingerprint fence counts consecutive same-fingerprint failures and trips at the threshold", () => {
  const fence = new RuntimeErrorFingerprintFence();
  const first = fence.note("agent-1", "aaaaaaaa");
  expect(first).toEqual({ fingerprint: "aaaaaaaa", attempts: 1, fenced: false });
  const second = fence.note("agent-1", "aaaaaaaa");
  expect(second.attempts).toBe(2);
  expect(second.fenced).toBe(false);
  const third = fence.note("agent-1", "aaaaaaaa");
  expect(third.attempts).toBe(RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD);
  expect(third.fenced).toBe(true);
});

test("a different fingerprint restarts the streak instead of accumulating with the old one", () => {
  const fence = new RuntimeErrorFingerprintFence();
  fence.note("agent-1", "aaaaaaaa");
  fence.note("agent-1", "aaaaaaaa");
  const changed = fence.note("agent-1", "bbbbbbbb");
  expect(changed).toEqual({ fingerprint: "bbbbbbbb", attempts: 1, fenced: false });
});

test("runtimeErrorFingerprintFenceDetail names the attempt count, the last error, and a recovery step", () => {
  const detail = runtimeErrorFingerprintFenceDetail(
    { fingerprint: "aaaaaaaa", attempts: 3, fenced: true },
    "connect ECONNRESET",
  );
  expect(detail).toContain("3");
  expect(detail).toContain("connect ECONNRESET");
  expect(detail.toLowerCase()).toContain("restart");
});

test("fence.reset clears the streak for that Agent only", () => {
  const fence = new RuntimeErrorFingerprintFence();
  fence.note("agent-1", "aaaaaaaa");
  fence.note("agent-2", "cccccccc");
  fence.reset("agent-1");
  expect(fence.note("agent-1", "aaaaaaaa").attempts).toBe(1);
  expect(fence.note("agent-2", "cccccccc").attempts).toBe(2);
});
