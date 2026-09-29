import { expect, test } from "bun:test";

import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const directory = "/coforge/workspaces/workspace-a/agents/agent-a";
const AGENT_WORKSPACES: [string, string] = [
  "/coforge/workspaces/workspace-a/agents/agent-a",
  "/coforge/workspaces/workspace-b/agents/agent-b",
];
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
  expect(instructions).not.toContain("before you finish that turn");
});

test("before a long task, progress goes to notes/active-context.md rather than MEMORY.md", () => {
  expect(instructions).toContain(
    "Before a long task, note where you are in notes/active-context.md to resume.",
  );
  expect(instructions).not.toContain("Active Context");
});

test("retains reply instructions and thread addressing without provider tool names", () => {
  expect(instructions).toContain(
    "text outside an executed `coforge message send` command is not delivered",
  );
  expect(instructions).toContain("Reply to direct user messages");
  expect(instructions).toContain("exact `target=`");
  expect(instructions).toContain("including its thread suffix");
  expect(instructions).toContain(
    "Send the reply on stdin with `coforge message send --target <target>`",
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

test("recovers context on demand without loading the Manual into every session", () => {
  expect(instructions).toContain("coforge message check --target");
  expect(instructions).toContain("Do not announce the notice or read MEMORY.md first");
  expect(instructions).toContain("an inbox notice is not missing context");
  expect(instructions).toContain("coforge message search");
  expect(instructions).toContain("read --around");
  expect(instructions).not.toContain("coforge manual get");
  expect(instructions).not.toContain("## Help");
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
  ])
    expect(rendered).toContain(`- ${line}`);
  for (const line of ["Hostname: host", "OS: linux", "Computer version: v1.0"])
    expect(rendered).not.toContain(`- ${line}`);
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

test("the openviking-memory profile requires an @memory query and never mentions tenant tokens", () => {
  const fenced = buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: AGENT_WORKSPACES[0],
    toolProfile: "openviking-memory",
  });
  expect(fenced).toContain("## Team memory (Memory Agent)");
  expect(fenced).toContain("explicit @memory question requires a memory query");
  expect(fenced).not.toContain("Bearer");
  expect(fenced).not.toContain("CAUSAL_MEMORY_TOKENS");
  expect(
    buildCoforgeAgentInstructions({ agentWorkspaceDirectory: AGENT_WORKSPACES[0] }),
  ).not.toContain("## Team memory (Memory Agent)");
});

const OPENVIKING_FENCE_TOOLS = ["ov_find", "ov_search_context", "ov_read", "memory_offer"] as const;
const CAUSAL_ONLY_TOOLS = [
  "causal_search",
  "causal_trace",
  "causal_intervention",
  "causal_propose_correction",
] as const;
const MUTATION_TOOL_NAMES = [
  "bash",
  "shell",
  "write",
  "edit",
  "apply_patch",
  "filesystem",
  "network",
  "ov_write",
  "ov_commit",
  "session_commit",
] as const;
const CREDENTIAL_WORDS = [
  "Bearer",
  "credential",
  "token",
  "endpoint",
  "secret",
  "password",
  "api key",
  "API key",
] as const;
const ALLOWED_MUTATION_PHRASES = [
  "you may write",
  "you can write",
  "you may commit",
  "you can commit",
  "you may mutate",
  "you can mutate",
  "you may invalidate",
  "you can supersede",
] as const;

function memoryAgentSection(prompt: string): string {
  const start = prompt.indexOf("## Team memory (Memory Agent)");
  expect(start).toBeGreaterThan(-1);
  const after = prompt.slice(start);
  const next = after.slice(1).search(/\n## /);
  return next === -1 ? after : after.slice(0, next + 1);
}

function allowedToolsetListing(section: string): string {
  const match = section.match(/Your tools are the whole toolset:\n([\s\S]*?)\n\n-/);
  expect(match?.[1]).toBeDefined();
  return match![1]!;
}

function instructionsForFence(toolProfile: "openviking-memory"): string {
  return buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: AGENT_WORKSPACES[0],
    toolProfile,
  });
}

test("the openviking-memory fence names only its read tools and memory_offer", () => {
  const section = memoryAgentSection(instructionsForFence("openviking-memory"));
  const listing = allowedToolsetListing(section);
  for (const name of OPENVIKING_FENCE_TOOLS) expect(listing).toContain(name);
  for (const name of CAUSAL_ONLY_TOOLS) expect(listing).not.toContain(name);
  expect(section).toContain("explicit @memory question requires a memory query");
  expect(section).toContain("cannot write files");
  expect(section).toContain("commit sessions");
  expect(section).toContain("skills or ACLs");
  expect(section).toContain("cannot directly modify OpenViking memory");
});

test("the memory fence lists no mutation tools and allows no mutation verbs", () => {
  const section = memoryAgentSection(instructionsForFence("openviking-memory"));
  const listing = allowedToolsetListing(section);
  for (const name of MUTATION_TOOL_NAMES) expect(listing).not.toContain(name);
  const allowedContext = listing.toLowerCase();
  expect(allowedContext).not.toMatch(/\bwrite\b/);
  expect(allowedContext).not.toMatch(/\bcommit\b/);
  expect(allowedContext).not.toMatch(/\bmutate\b/);
  expect(allowedContext).not.toMatch(/\binvalidate\b/);
  expect(allowedContext).not.toMatch(/\bsupersede\b/);
  const lowered = section.toLowerCase();
  for (const phrase of ALLOWED_MUTATION_PHRASES) expect(lowered).not.toContain(phrase);
});

test("the memory fence renders no credentials, tokens, or hidden endpoints", () => {
  const section = memoryAgentSection(instructionsForFence("openviking-memory"));
  for (const word of CREDENTIAL_WORDS) expect(section).not.toContain(word);
  expect(section).not.toContain("/api/");
  expect(section).not.toMatch(/https?:\/\//);
  expect(section).not.toContain("localhost");
});
