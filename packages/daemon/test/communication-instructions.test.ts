import { expect, test } from "bun:test";

import { COFORGE_AGENT_INSTRUCTIONS } from "../src/code-agent/communication-instructions";

test("direct user messages require a visible CoForge reply", () => {
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "When you receive a direct user message, process it and reply with `coforge message send`.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "The CLI is your only output channel: text outside an executed `coforge message send` command is not delivered to anyone.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "Execute the command with the Bash tool; never print, quote, or describe the command as your answer.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "After `coforge message check` returns a direct user message, you must execute a Bash tool call containing `coforge message send` before ending the turn.",
  );
});

test("channels allow selective replies and self mute without hiding history", () => {
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain("coforge channel mute --target '#general'");
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain("coforge channel unmute --target '#general'");
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain("Do not reply to every ordinary channel message.");
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "Human personal @mentions still notify you while muted.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain(
    "Unmuting does not replay messages from the muted period.",
  );
  expect(COFORGE_AGENT_INSTRUCTIONS).toContain("Do not disclose private conversation contents");
});
