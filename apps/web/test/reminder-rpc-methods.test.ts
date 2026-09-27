import { describe, expect, test } from "bun:test";
import { reminderCallbackMethods } from "#src/server/centrifugo/rpc-composition.server";
import type { CentrifugoRpcMethod } from "#src/server/centrifugo/rpc-handler.server";

const noop: CentrifugoRpcMethod = () => new Uint8Array();
const other: CentrifugoRpcMethod = () => new Uint8Array();

/**
 * The reminder callbacks register under their current names only: the upgrade window that also
 * answered the pre-convention `reminder:v1:*` spellings closed with 0.1.0, so an unsupported
 * Computer sending the old names sees Centrifugo's `104` rather than a silent miss.
 */
describe("reminderCallbackMethods", () => {
  const methods = reminderCallbackMethods(noop, other);

  test("answers the current names", () => {
    expect(methods["agent:v1:reminder:fire"]).toBe(noop);
    expect(methods["agent:v1:reminder:snapshot"]).toBe(other);
  });

  test("registers exactly the two names, so no legacy spelling lingers", () => {
    expect(Object.keys(methods).sort()).toEqual([
      "agent:v1:reminder:fire",
      "agent:v1:reminder:snapshot",
    ]);
  });
});
