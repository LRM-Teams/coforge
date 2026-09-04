import { expect, test } from "bun:test";

import { COFORGE_AGENT_INSTRUCTIONS } from "../src/code-agent/communication-instructions";

test("ordinary user messages require a visible CoForge reply", () => {
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "When you receive an ordinary user message, process it and reply with `coforge message send`.",
  );
});
