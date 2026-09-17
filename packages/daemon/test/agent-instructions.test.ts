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

test("channel management authority matches Raft's per-channel rule and disclaims Agent role changes", () => {
  expect(instructions).toContain(
    "Channel management commands (`channel create`, `update`, `lifecycle archive|unarchive`, `add-member`, `remove-member`) are authorized per channel",
  );
  expect(instructions).toContain(
    "a channel-admin role never grants delete, visibility, federation, or server-profile actions",
  );
  expect(instructions).toContain("There is no Agent command for changing channel roles.");
  expect(instructions).toContain(
    "`channel info`/`channel members` show your server and stored channel roles separately when available.",
  );
});

test("read, search, and send-held describe the CLI's printed output formats", () => {
  expect(instructions).toContain(
    'A read prints a window header with "Older exist"/"Newer exist" cursor commands you can paste to page further',
  );
  expect(instructions).toContain(
    "numbered message lines that each carry a `replyTarget` to reuse when replying in that thread",
  );
  expect(instructions).toContain('a closing "End of window" line');
  expect(instructions).toContain(
    'Search results come as `<result ref="msg:...">` blocks whose `<preview>` marks the matched text',
  );
  expect(instructions).toContain(
    "rewrites quoted `@name`/`#chan`/`task #n` references to `user:name`/`channel:name`/`task:n`",
  );
  expect(instructions).toContain("so they are never mistaken for real targets");
  expect(instructions).toContain(
    "the hold output lists the newer messages as preview lines before the draft instructions",
  );
});

test("a failed send with a saved draft must not be retried automatically", () => {
  expect(instructions).toContain("`Draft saved: yes`");
  expect(instructions).toContain("delivery is unknown, not failed: do not resend");
  expect(instructions).toContain(
    "`coforge message send --send-draft` after such a failure is a person's deliberate decision",
  );
});

test("resolve and react are scoped to proving/reading an id and deliberate acknowledgement", () => {
  expect(instructions).toContain("coforge message resolve <message-id>");
  expect(instructions).toContain(
    "to prove a message id exists or to read exactly one message by id",
  );
  expect(instructions).toContain(
    "coforge message react --message-id <id> --emoji <emoji> [--remove]",
  );
  expect(instructions).toContain("only when a human explicitly asks for a reaction");
  expect(instructions).toContain("never react automatically on routine updates");
});

test("Tasks require claim-before-work and conversational human acceptance", () => {
  expect(instructions).toContain("**Decision rule:**");
  expect(instructions).toContain("Task commands use the parent target");
  expect(instructions).toContain("claim its root Message, not the reply Message");
  expect(instructions).toContain("If the claim fails, do not start conflicting execution");
  expect(instructions).toContain("When done, set status to `in_review`");
  expect(instructions).toContain("After approval, set status to `done`");
  expect(instructions).toContain("**Claim** is rejected on both terminal statuses");
  expect(instructions).toContain("**What `coforge task create` really means:**");
  expect(instructions).toContain("Before calling `coforge task create`");
  expect(instructions).not.toContain("Task updates use revisions");
  expect(instructions).not.toContain("COFORGE_REVIEWER_ISOLATION");
  expect(instructions).not.toContain("coforge task receipt");
});

test("project code is discovered through workspace info and cloned with the owner's GitHub credential", () => {
  expect(instructions).toContain("coforge workspace info --projects");
  expect(instructions).toContain("github=<owner>/<repo>");
  expect(instructions).toContain("git clone https://github.com/<owner>/<repo>.git");
  expect(instructions).toContain("Never ask for a token, SSH key, or deploy key");
  expect(instructions).toContain("do not run `gh auth login`");
});
