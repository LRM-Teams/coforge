import { expect, test } from "bun:test";
import {
  classifyRuntimeErrorText,
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
} from "#src/agent-runtime/runtime-error-classification";

test("classifies a rate-limit message as retryable", () => {
  const result = classifyRuntimeErrorText("You are being rate limited, please slow down");
  expect(result).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "rate_limited",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
  });
});

test("classifies too-many-requests wording as rate limit", () => {
  expect(classifyRuntimeErrorText("429 Too Many Requests").errorClass).toBe(
    RUNTIME_ERROR_CLASS.RATE_LIMIT,
  );
});

test("classifies a provider 5xx as a retryable server error", () => {
  const result = classifyRuntimeErrorText("upstream error: 503 Service Unavailable");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.PROVIDER_SERVER);
  expect(result.errorReason).toBe("provider_server_error");
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies a connection reset as a retryable provider connection error", () => {
  const result = classifyRuntimeErrorText("connect ECONNRESET 10.0.0.1:443");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.PROVIDER_CONNECTION);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies an unexpectedly closed stream as a retryable provider stream error", () => {
  const result = classifyRuntimeErrorText("stream closed unexpectedly before completion");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.PROVIDER_STREAM);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies a generic not-found message as retryable", () => {
  const result = classifyRuntimeErrorText("conversation resource not found");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.NOT_FOUND);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies a timeout as terminal-for-this-process (retrying will not help)", () => {
  const result = classifyRuntimeErrorText("the request timed out after 60000ms");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.TIMEOUT);
  expect(result.errorReason).toBe("provider_timeout");
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("classifies an auth/login failure as terminal", () => {
  const result = classifyRuntimeErrorText("Unauthorized: please sign in again");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.AUTH);
  expect(result.errorReason).toBe("auth_required");
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("classifies an unsupported model as terminal", () => {
  const result = classifyRuntimeErrorText("The requested model is not supported");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.MODEL_CONFIG);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("classifies an oversized prompt as terminal", () => {
  const result = classifyRuntimeErrorText("input is too large: exceeds the maximum context size");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.INPUT_TOO_LARGE);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("classifies a launcher/spawn failure as terminal", () => {
  const result = classifyRuntimeErrorText("spawn codex ENOENT");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.LAUNCHER);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("falls back to the generic runtime error class for unrecognized text, treated as retryable", () => {
  const result = classifyRuntimeErrorText("provider request failed");
  expect(result).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
    errorReason: "runtime_failure",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
  });
});

test("model-not-found text is model config, not the generic not-found class", () => {
  const result = classifyRuntimeErrorText("model gpt-9 not found");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.MODEL_CONFIG);
});
