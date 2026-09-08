import { expect, test } from "bun:test";
import { COFORGE_AGENT_RUNTIME_METADATA } from "../src/code-agent/pi/metadata";
import { COFORGE_DAEMON_VERSION } from "../src/version";

test("daemon reports the release version of its built-in CoForge Agent", () => {
  expect(COFORGE_AGENT_RUNTIME_METADATA).toEqual({
    provider: "coforge",
    version: COFORGE_DAEMON_VERSION,
    displayName: "CoForge",
  });
});
