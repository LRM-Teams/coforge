import { expect, test } from "bun:test";
import { decodeAgentVersionResponse, type AgentVersionResponse } from "./version";

test("decodeAgentVersionResponse accepts a fully populated response", () => {
  const value: AgentVersionResponse = {
    ok: true,
    daemonVersion: "0.1.0-dev.38",
    computerVersion: "0.1.0-dev.38",
    daemonPid: 4242,
    startedAt: 1_726_000_000_000,
  };
  expect(decodeAgentVersionResponse(value)).toEqual(value);
});

test("decodeAgentVersionResponse accepts the minimal shape: only ok and daemonVersion", () => {
  const value: AgentVersionResponse = { ok: true, daemonVersion: "0.1.0-dev.38" };
  expect(decodeAgentVersionResponse(value)).toEqual(value);
});

test("decodeAgentVersionResponse rejects a missing or wrong-typed required field", () => {
  const valid = { ok: true, daemonVersion: "0.1.0-dev.38" };
  expect(() => decodeAgentVersionResponse({ ...valid, ok: false })).toThrow();
  expect(() => decodeAgentVersionResponse({ ...valid, daemonVersion: undefined })).toThrow();
  expect(() => decodeAgentVersionResponse({ ...valid, daemonVersion: 1 })).toThrow();
  expect(() => decodeAgentVersionResponse(null)).toThrow();
  expect(() => decodeAgentVersionResponse("0.1.0")).toThrow();
});

test("decodeAgentVersionResponse rejects a wrong-typed optional field", () => {
  const valid = { ok: true, daemonVersion: "0.1.0-dev.38" };
  expect(() => decodeAgentVersionResponse({ ...valid, computerVersion: 1 })).toThrow();
  expect(() => decodeAgentVersionResponse({ ...valid, daemonPid: "4242" })).toThrow();
  expect(() => decodeAgentVersionResponse({ ...valid, startedAt: "now" })).toThrow();
});
