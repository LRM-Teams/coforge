import { expect, test } from "bun:test";

import { buildCoforgeAgentInstructions } from "../src/code-agent/agent-instructions";

const AGENT_WORKSPACES: [string, string] = [
  "/coforge/workspaces/workspace-a/agents/agent-a",
  "/coforge/workspaces/workspace-b/agents/agent-b",
];
const instructions = buildCoforgeAgentInstructions(AGENT_WORKSPACES[0]);

test.each(AGENT_WORKSPACES)(
  "identifies exactly the configured Agent workspace before the standing instructions",
  (agentWorkspace) => {
    const rendered = buildCoforgeAgentInstructions(agentWorkspace);
    const communicationSection = rendered.indexOf("## CoForge communication");

    expect(rendered.match(/^## Current Runtime Context$/gm)).toHaveLength(1);
    expect(rendered.match(/^- Agent workspace: /gm)).toHaveLength(1);
    expect(rendered.match(/^- Agent workspace: (.+)$/m)?.[1]).toBe(agentWorkspace);
    expect(rendered.split(agentWorkspace)).toHaveLength(2);
    expect(rendered.indexOf(agentWorkspace)).toBeLessThan(communicationSection);
    expect(rendered).not.toContain("Current working directory:");
    expect(rendered).not.toContain("MEMORY.md");
  },
);

test("direct user messages require a visible CoForge reply", () => {
  expect(instructions).toContain(
    "When you receive a direct user message, process it and reply with `coforge message send`.",
  );
  expect(instructions).toContain(
    "The CLI is your only output channel: text outside an executed `coforge message send` command is not delivered to anyone.",
  );
  expect(instructions).toContain(
    "Execute the command with the Bash tool; never print, quote, or describe the command as your answer.",
  );
  expect(instructions).toContain(
    "After `coforge message check` returns a direct user message, you must execute a Bash tool call containing `coforge message send` before ending the turn.",
  );
});

test("channels allow selective replies and self mute without hiding history", () => {
  expect(instructions).toContain("coforge channel mute --target '#general'");
  expect(instructions).toContain("coforge channel unmute --target '#general'");
  expect(instructions).toContain("#general:12345678");
  expect(instructions).toContain("Channel thread replies stay in their thread");
  expect(instructions).toContain("coforge message read --target '#general:12345678'");
  expect(instructions).toContain("coforge message read --target '#general' --around 12345678");
  expect(instructions).toContain("automatically follow it");
  expect(instructions).toContain("coforge thread unfollow --target '#general:12345678'");
  expect(instructions).toContain(
    "A parent channel mute does not suppress replies in threads you follow",
  );
  expect(instructions).toContain("Do not reply to every ordinary channel message.");
  expect(instructions).toContain("Human personal @mentions still notify you while muted.");
  expect(instructions).toContain("Unmuting does not replay messages from the muted period.");
  expect(instructions).toContain("Do not disclose private conversation contents");
});

test("Tasks require claim-before-work and conversational human acceptance", () => {
  expect(instructions).toContain("coforge task list --target <target>");
  expect(instructions).toContain("Task commands use the parent target");
  expect(instructions).toContain("claim its root Message, not the reply Message");
  expect(instructions).toContain("If claiming fails, do not perform conflicting work.");
  expect(instructions).toContain("original Task Thread");
  expect(instructions).toContain("only after a human clearly accepts the result");
  expect(instructions).toContain("not an automatic approval detector");
  expect(instructions).toContain("Do not turn ordinary conversation into Tasks.");
  expect(instructions).not.toContain("assign --");
});
