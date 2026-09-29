import { expect, test } from "bun:test";

import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const directory = "/coforge/workspaces/workspace-a/agents/agent-a";
const instructions = buildCoforgeAgentInstructions({ agentWorkspaceDirectory: directory });

test("ordinary requests do not require task creation or per-turn memory bookkeeping", () => {
  expect(instructions).toContain("Answer ordinary questions freely");
  expect(instructions).toContain("Before implementing a shared channel request");
  expect(instructions).toContain(
    "coforge task claim --target <channel> --message-id <root-message-id>",
  );
  expect(instructions).toContain("Only a successful claimant implements");
  expect(instructions).toContain("others may analyze or review in its thread");
  expect(instructions).toContain("If a claim fails, do not start conflicting execution");
  expect(instructions).toContain("when this request lacks context");
  expect(instructions).not.toContain("## Startup sequence");
  expect(instructions).not.toContain("Before a long task");
  expect(instructions).not.toContain("before you finish that turn");
});

test("retains an executable reply example and thread addressing without provider tool names", () => {
  expect(instructions).toContain(
    "text outside an executed `coforge message send` command is not delivered",
  );
  expect(instructions).toContain("Reply to direct user messages");
  expect(instructions).toContain("exact `target=`");
  expect(instructions).toContain("including its thread suffix");
  expect(instructions).toContain(
    "coforge message send --target '@alice' <<'COFORGE_MESSAGE'\nYour reply\nCOFORGE_MESSAGE",
  );
  expect(instructions).not.toContain("Bash tool");
});

test("replies where the conversation is, by default rather than as a hard rule", () => {
  expect(instructions).toContain(
    "a top-level message gets a top-level reply, a thread message a reply in its thread, and a request you claimed as a Task its Task thread",
  );
  expect(instructions).toContain(
    "You may post a new topic or a thread's conclusion at top level, or use the place a human names",
  );
  expect(instructions).toContain(
    "This is a default, not a hard rule; decide a thread-mismatch send confirmation by it",
  );
  expect(instructions).not.toContain("Start a thread or move to top level only for a new topic");
});

test("preserves privacy, credential handling and uncertain-send safety", () => {
  expect(instructions).toContain(
    "Never disclose private DM contents or secrets to a public channel",
  );
  expect(instructions).toContain("Do not solicit or expose credentials");
  expect(instructions).toContain("Draft saved: yes");
  expect(instructions).toContain("do not resend automatically");
  // A failed same-key replay whose draft still holds the key is the one retry the Agent runs itself.
  expect(instructions).toContain("If a failed send says `Retryable: yes`, run its next action");
});

test("recovers context on demand and keeps help discoverable", () => {
  expect(instructions).toContain("coforge message check --target");
  expect(instructions).toContain("Do not announce the notice or read MEMORY.md first");
  expect(instructions).toContain("an inbox notice is not missing context");
  expect(instructions).toContain("coforge message search");
  expect(instructions).toContain("read --around");
  expect(instructions).toContain("coforge manual get");
  expect(instructions).not.toContain("automatically join");
  expect(instructions).not.toContain("Use channel mute");
});

test("identity is optional and the configured directory appears exactly once", () => {
  expect(instructions.startsWith("You are an AI agent in CoForge.")).toBe(true);
  expect(instructions.split(directory)).toHaveLength(2);
  expect(instructions).not.toContain("- Username:");
  expect(instructions).not.toContain("- Role:");
  expect(instructions).not.toContain("- Hostname:");
});

test("known runtime identity remains available without repeating the role", () => {
  const rendered = buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: directory,
    agentId: "agent-1",
    identity: {
      name: "scout",
      displayName: 'Scout "the\nBuilder"',
      description: "## Reviews\npull requests.",
      runtimeContext: {
        workspaceName: "Acme",
        workspaceSlug: "acme",
        computerName: "Builder",
        computerId: "computer-1",
        computerHostname: "host",
        computerOs: "linux",
        computerVersion: "1.0",
      },
    },
  });
  expect(rendered.startsWith('You are "Scout the Builder", an AI agent in CoForge.')).toBe(true);
  expect(rendered).toContain("- Role: Reviews pull requests.");
  expect(rendered.split("Reviews pull requests.")).toHaveLength(2);
  expect(rendered).not.toContain("## Reviews");
  for (const line of [
    "Username: @scout",
    "Agent ID: agent-1",
    "Workspace: Acme (acme)",
    "Computer: Builder (computer-1)",
    "Hostname: host",
    "OS: linux",
    "Computer version: v1.0",
  ])
    expect(rendered).toContain(`- ${line}`);
});

test("runtime labels work without IDs and IDs work without labels", () => {
  const rendered = buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: directory,
    identity: { name: "scout", runtimeContext: { computerName: "Builder", workspaceSlug: "acme" } },
  });
  expect(rendered.startsWith('You are "scout"')).toBe(true);
  expect(rendered).toContain("- Computer: Builder\n");
  expect(rendered).toContain("- Workspace: acme\n");
});

test("provider-specific rules remain available once when supplied", () => {
  const rendered = buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: directory,
    extraCriticalRules: ["- This runtime uses PowerShell."],
  });
  expect(rendered.split("- This runtime uses PowerShell.")).toHaveLength(2);
});

test("the fixed transport guidance stays within a 3KB budget", () => {
  expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(3072);
});
