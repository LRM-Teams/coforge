import { expect, test } from "bun:test";
import { BUILTIN_PI_RUNTIME_METADATA } from "../src/code-agent/pi/metadata";

test("daemon identifies its release-provided Pi as builtin", () => {
  expect(BUILTIN_PI_RUNTIME_METADATA).toMatchObject({ provider: "pi", kind: "builtin" });
});
