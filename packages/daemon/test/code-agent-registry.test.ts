import { expect, test } from "bun:test";

import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { createCodeAgentProvider } from "../src/code-agent/registry";

test("code-agent registry exposes every supported Provider", () => {
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.COFORGE).provider).toBe(RUNTIME_PROVIDER.COFORGE);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.PI).provider).toBe(RUNTIME_PROVIDER.PI);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CODEX).provider).toBe(RUNTIME_PROVIDER.CODEX);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CLAUDE_CODE).provider).toBe(
    RUNTIME_PROVIDER.CLAUDE_CODE,
  );
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.KIRO).provider).toBe(RUNTIME_PROVIDER.KIRO);
});
