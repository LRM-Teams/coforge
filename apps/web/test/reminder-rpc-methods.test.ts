import { describe, expect, test } from "bun:test";
import { reminderCallbackMethods } from "../src/server/centrifugo/rpc-composition.server";
import type { CentrifugoRpcMethod } from "../src/server/centrifugo/rpc-handler.server";

const noop: CentrifugoRpcMethod = () => new Uint8Array();
const other: CentrifugoRpcMethod = () => new Uint8Array();

/**
 * A renamed RPC method is answered under both spellings for the length of an upgrade window: the
 * cloud deploys before the Computers upgrade, so the side that has not changed yet is the one the
 * other must still answer. If only one name were registered, an installed Computer's reminder would
 * fail exactly the way it did before `reminder` was routable at all — silently, after its retries.
 */
describe("reminderCallbackMethods", () => {
  const methods = reminderCallbackMethods(noop, other);

  test("answers the current names", () => {
    expect(methods["agent:v1:reminder:fire"]).toBe(noop);
    expect(methods["agent:v1:reminder:snapshot"]).toBe(other);
  });

  test("answers the pre-convention spellings an installed Computer sends", () => {
    expect(methods["reminder:v1:fire"]).toBe(noop);
    expect(methods["reminder:v1:snapshot"]).toBe(other);
  });

  test("registers four distinct keys, so neither pair can silently replace the other", () => {
    expect(Object.keys(methods).sort()).toEqual([
      "agent:v1:reminder:fire",
      "agent:v1:reminder:snapshot",
      "reminder:v1:fire",
      "reminder:v1:snapshot",
    ]);
  });
});
