import { expect, test } from "bun:test";
import { LEGACY_RPC_METHOD_NAMES, RPC_METHODS, currentRpcMethodName } from "./rpc-methods";

test("maps every pre-rename method to the current name it stands for", () => {
  for (const [name, legacy] of Object.entries(LEGACY_RPC_METHOD_NAMES))
    expect(currentRpcMethodName(legacy)).toBe(RPC_METHODS[name as keyof typeof RPC_METHODS]);
});

test("keeps every pre-rename spelling out of the current vocabulary", () => {
  const currentNames = new Set<string>(Object.values(RPC_METHODS));
  for (const [name, legacy] of Object.entries(LEGACY_RPC_METHOD_NAMES)) {
    // A no-op alias would say the method was renamed when it was not, and a legacy spelling that
    // equals some *other* current name would shadow it.
    expect(legacy).not.toBe(RPC_METHODS[name as keyof typeof RPC_METHODS]);
    expect(currentNames.has(legacy)).toBe(false);
  }
});

test("answers undefined for a current or unknown method name", () => {
  expect(currentRpcMethodName(RPC_METHODS.agentMessage)).toBeUndefined();
  expect(currentRpcMethodName("agent:v1:nope")).toBeUndefined();
});
