import { expect, test } from "bun:test";
import {
  buildRuntimeErrorActivity,
  buildRuntimeCrashedActivity,
  buildRuntimeReconnectingActivity,
  scrubRuntimeErrorText,
  fingerprintRuntimeError,
} from "../src/agent-runtime/runtime-error-activity";

test("builds a runtime_error activity from the provider's message as reported, with an Error: entry and structured fields", () => {
  const long = "x".repeat(600);
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: `request timed out ${long}`,
  });
  expect(activity.detailKind).toBe("runtime_error");
  expect(activity.level).toBe("error");
  expect(activity.detail).toBe(`request timed out ${long}`);
  expect(activity.entries).toEqual([{ kind: "text", text: `Error: ${activity.detail}` }]);
  // No provider hint was given, so the daemon's own text classification fills errorClass/
  // errorReason (runtime-error-classification.ts) instead of the old generic default.
  expect(activity.runtimeError).toMatchObject({
    errorClass: "TimeoutError",
    errorReason: "provider_timeout",
  });
  expect(activity.runtimeError!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
});

test("falls back to the generic class/reason when no provider hint and no text pattern matches", () => {
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: "provider request failed",
  });
  expect(activity.runtimeError).toMatchObject({
    errorClass: "AgentRuntimeError",
    errorReason: "runtime_failure",
  });
});

test("prefers provider-supplied error class/code/reason hints when present", () => {
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: "turn failed",
    providerErrorClass: "invalid_request",
    providerErrorReason: "turn_failed",
  });
  expect(activity.runtimeError).toMatchObject({
    errorClass: "invalid_request",
    errorReason: "turn_failed",
  });
});

test("falls back to providerErrorCode for errorClass when no providerErrorClass is given", () => {
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: "turn failed",
    providerErrorCode: "-32600",
  });
  expect(activity.runtimeError!.errorClass).toBe("-32600");
});

test("uses occurredAt when the provider supplies it, else the current time", () => {
  const occurredAt = "2026-09-17T00:00:00.000Z";
  const activity = buildRuntimeErrorActivity({ type: "error", message: "boom", occurredAt });
  expect(activity.observedAtMs).toBe(Date.parse(occurredAt));
  const now = buildRuntimeErrorActivity({ type: "error", message: "boom" });
  expect(now.observedAtMs).toBeGreaterThan(0);
});

test("two error events with the same message fingerprint identically", () => {
  const a = buildRuntimeErrorActivity({ type: "error", message: "timeout after 30s" });
  const b = buildRuntimeErrorActivity({ type: "error", message: "timeout after 30s" });
  expect(a.runtimeError!.fingerprint).toBe(b.runtimeError!.fingerprint);
});

test("builds a runtime_crashed activity from the last unresolved error, with Crashed(...) wording", () => {
  const activity = buildRuntimeCrashedActivity({
    type: "error",
    message: "code agent process exited unexpectedly",
  });
  expect(activity.detailKind).toBe("runtime_crashed");
  expect(activity.level).toBe("error");
  expect(activity.detail).toBe("Crashed (code agent process exited unexpectedly)");
  expect(activity.entries).toEqual([
    { kind: "text", text: "Error: Crashed (code agent process exited unexpectedly)" },
  ]);
  expect(activity.runtimeError!.errorReason).toBe("runtime_crashed");
});

test("redacts the crashed message too", () => {
  const activity = buildRuntimeCrashedActivity({
    type: "error",
    message: "Bearer sk-fixture-private-token",
  });
  expect(activity.detail).not.toContain("sk-fixture-private-token");
});

test("builds a runtime_reconnecting activity with a default message when the provider gives none", () => {
  const withMessage = buildRuntimeReconnectingActivity({
    type: "reconnecting",
    attempt: 2,
    message: "Reconnecting... 2/5",
  });
  expect(withMessage).toMatchObject({
    detailKind: "runtime_reconnecting",
    level: "info",
    detail: "Reconnecting... 2/5",
    entries: [{ kind: "text", text: "Reconnecting... 2/5" }],
  });
  const withoutMessage = buildRuntimeReconnectingActivity({ type: "reconnecting" });
  expect(withoutMessage.detail).toBe("Reconnecting to provider…");
});

test("scrubRuntimeErrorText redacts tokens/secrets/Bearer and caps at 512 chars", () => {
  expect(scrubRuntimeErrorText("password=hunter2 rest")).toBe("password=[REDACTED] rest");
  expect(scrubRuntimeErrorText("Bearer abc.def")).toBe("Bearer [REDACTED]");
  expect(scrubRuntimeErrorText("sk-abcdef123456")).toBe("[REDACTED]");
  expect(scrubRuntimeErrorText("x".repeat(600)).length).toBe(512);
});

test("fingerprintRuntimeError is a stable 8-hex-character hash", () => {
  expect(fingerprintRuntimeError("same")).toBe(fingerprintRuntimeError("same"));
  expect(fingerprintRuntimeError("same")).not.toBe(fingerprintRuntimeError("different"));
  expect(fingerprintRuntimeError("same")).toMatch(/^[0-9a-f]{8}$/);
});
