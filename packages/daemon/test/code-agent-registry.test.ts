import { expect, test } from "bun:test";

import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { createAgentDriver } from "../src/code-agent/registry";

test("code-agent registry exposes Pi, Codex, and Claude Code", () => {
  expect(createAgentDriver(RUNTIME_PROVIDER.PI).provider).toBe(RUNTIME_PROVIDER.PI);
  expect(createAgentDriver(RUNTIME_PROVIDER.CODEX).provider).toBe(RUNTIME_PROVIDER.CODEX);
  expect(createAgentDriver(RUNTIME_PROVIDER.CLAUDE_CODE).provider).toBe(
    RUNTIME_PROVIDER.CLAUDE_CODE,
  );
});
