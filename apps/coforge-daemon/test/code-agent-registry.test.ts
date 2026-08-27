import { expect, test } from "bun:test";

import { createCodeAgentAdapter } from "../src/code-agent/registry";

test("code-agent registry exposes Pi, Codex, and Claude Code", () => {
  expect(createCodeAgentAdapter("pi").provider).toBe("pi");
  expect(createCodeAgentAdapter("codex").provider).toBe("codex");
  expect(createCodeAgentAdapter("claude-code").provider).toBe("claude-code");
});
