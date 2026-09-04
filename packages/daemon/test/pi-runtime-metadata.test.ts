import { expect, test } from "bun:test";
import { COFORGE_AGENT_RUNTIME_METADATA } from "../src/code-agent/pi/metadata";

test("daemon identifies its release-provided CoForge Agent by provider", () => {
  expect(COFORGE_AGENT_RUNTIME_METADATA).toMatchObject({ provider: "coforge" });
});
