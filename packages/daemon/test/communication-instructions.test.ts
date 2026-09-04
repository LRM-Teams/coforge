import { expect, test } from "bun:test";

import { COFORGE_AGENT_INSTRUCTIONS } from "../src/code-agent/communication-instructions";

test("ordinary user messages require a visible CoForge reply", () => {
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "When you receive an ordinary user message, process it and reply with `coforge message send`.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "The CLI is your only output channel: text outside an executed `coforge message send` command is not delivered to anyone.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "Execute the command with the Bash tool; never print, quote, or describe the command as your answer.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "After `coforge message check` returns an ordinary user message, you must execute a Bash tool call containing `coforge message send` before ending the turn.",
  );
});
