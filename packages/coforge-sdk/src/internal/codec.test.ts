import { expect, test } from "bun:test";
import { boundedPayload } from "./codec";
test("boundedPayload refuses a payload over the limit, naming the message type", () => {
  const bytes = new Uint8Array(5);
  expect(boundedPayload(bytes, 5, "Skills")).toBe(bytes);
  expect(() => boundedPayload(bytes, 4, "Skills")).toThrow("Skills payload too large");
  expect(() => boundedPayload(bytes, 4, "Agent lifecycle")).toThrow(
    "Agent lifecycle payload too large",
  );
});
