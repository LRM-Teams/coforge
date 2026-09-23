import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import {
  formatHeldSend,
  formatMessageLine,
  formatReadWindow,
  formatSearchResults,
  formatSendSuccess,
  formatUtcTimestamp,
  neutralizeReferenceLiterals,
  renderSearchPreview,
} from "#src/message-format";

function message(overrides: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    sequence: 1,
    senderKind: "human",
    senderHandle: "ada",
    senderDescription: "",
    target: "#general",
    body: "hello there",
    createdAt: "2026-09-07T10:00:00Z",
    attachments: [],
    ...overrides,
  };
}

test("formatUtcTimestamp renders ISO input as UTC YYYY-MM-DD HH:MM:SSZ", () => {
  expect(formatUtcTimestamp("2026-09-07T10:05:09Z")).toBe("2026-09-07 10:05:09Z");
  expect(formatUtcTimestamp("2026-01-02T00:00:00.500Z")).toBe("2026-01-02 00:00:00Z");
});

test("formatMessageLine renders the shared bracket line with attachment and task suffixes", () => {
  expect(formatMessageLine(message())).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=human] @ada: hello there",
  );

  const withOneAttachment = message({
    attachments: [
      {
        id: "aaaa1111-0000-4000-8000-000000000001",
        fileName: "log.txt",
        contentType: "text/plain",
        sizeBytes: 10,
      },
    ],
  });
  expect(formatMessageLine(withOneAttachment)).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=human] @ada: hello there" +
      " [1 attachment: log.txt (id:aaaa1111-0000-4000-8000-000000000001) —" +
      " use `coforge attachment view --id <attachmentId> --output <path>` to download]",
  );

  const withTwoAttachments = message({
    attachments: [
      {
        id: "aaaa1111-0000-4000-8000-000000000001",
        fileName: "spec.md",
        contentType: "text/markdown",
        sizeBytes: 10,
      },
      {
        id: "bbbb2222-0000-4000-8000-000000000002",
        fileName: "diagram.png",
        contentType: "image/png",
        sizeBytes: 20,
      },
    ],
  });
  expect(formatMessageLine(withTwoAttachments)).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=human] @ada: hello there" +
      " [2 attachments: spec.md (id:aaaa1111-0000-4000-8000-000000000001)," +
      " diagram.png (id:bbbb2222-0000-4000-8000-000000000002) —" +
      " use `coforge attachment view --id <attachmentId> --output <path>` to download]",
  );

  const withTask = message({
    task: { number: 12, status: "in_progress", owner: { displayName: "Ada", handle: "ada" } },
  });
  expect(formatMessageLine(withTask)).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=human] @ada: hello there" +
      " [task #12 status=in_progress owner=@ada]",
  );

  const withDeletedOwner = message({
    task: {
      number: 46,
      status: "in_progress",
      owner: { displayName: "Kiro", handle: "kiro", deleted: true },
    },
  });
  expect(formatMessageLine(withDeletedOwner)).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=human] @ada: hello there" +
      " [task #46 status=in_progress owner=@kiro [deleted]]",
  );

  const withTaskNoOwner = message({ task: { number: 3, status: "todo" } });
  expect(formatMessageLine(withTaskNoOwner)).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=human] @ada: hello there" +
      " [task #3 status=todo]",
  );
});

test("formatMessageLine summarizes a long plain-channel body and keeps DM/thread text intact", () => {
  const longBody = `${"频道闲聊。".repeat(80)}结尾`;
  const channel = message({
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    target: "#general",
    body: longBody,
  });
  const rendered = formatMessageLine(channel);
  expect(rendered).toContain("…(+");
  expect(rendered).toContain('read: coforge message read --target "#general" --around bbbbbbbb');
  expect(rendered).not.toContain("结尾");
  expect(Array.from(rendered.slice(rendered.indexOf("@ada: ") + 6).split("…")[0]!).length).toBe(
    200,
  );

  const dm = message({ target: "@ada", body: longBody });
  expect(formatMessageLine(dm)).toContain("结尾");
  expect(formatMessageLine(dm)).not.toContain("…(+");

  const thread = message({ target: "#general:aaaaaaaa", body: longBody });
  expect(formatMessageLine(thread)).toContain("结尾");
  expect(formatMessageLine(thread)).not.toContain("…(+");

  const mentioned = message({ target: "#general", body: longBody, mentionsAgent: true });
  expect(formatMessageLine(mentioned)).toContain("结尾");
  expect(formatMessageLine(mentioned)).not.toContain("…(+");
});

test("formatMessageLine renders an Agent sender with its description and a system sender plainly", () => {
  const fromAgent = message({
    senderKind: "agent",
    senderHandle: "scout",
    senderDescription: "release bot",
    target: "#general",
    body: "deploy finished, all green",
  });
  expect(formatMessageLine(fromAgent)).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=agent] @scout — release bot: deploy finished, all green",
  );

  const fromAgentNoDescription = message({
    senderKind: "agent",
    senderHandle: "scout",
    senderDescription: "",
  });
  expect(formatMessageLine(fromAgentNoDescription)).toBe(
    "[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=agent] @scout: hello there",
  );

  const fromSystem = message({
    senderKind: "system",
    senderHandle: "",
    senderDescription: "",
    body: '📌 Assigned @scout to task #12 "Fix the login bug"',
  });
  expect(formatMessageLine(fromSystem)).toBe(
    '[target=#general msg=aaaaaaaa time=2026-09-07 10:00:00Z type=system] system: 📌 Assigned @scout to task #12 "Fix the login bug"',
  );
});

test("formatReadWindow reports older/newer availability and includes an around line", () => {
  const first = message({ id: "11111111-0000-4000-8000-000000000001", body: "first" });
  const second = message({ id: "22222222-0000-4000-8000-000000000002", body: "second" });
  const output = formatReadWindow(
    "#general",
    { messages: [first, second], hasOlder: true, hasNewer: true },
    { around: "22222222" },
  );
  const lines = output.split("\n");
  expect(lines[0]).toBe(
    'Read window: 2 returned, oldest to newest. Older exist: coforge message read --target "#general" --before 11111111. Newer exist: coforge message read --target "#general" --after 22222222.',
  );
  expect(lines[1]).toBe("Around: 22222222.");
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe(
    "[1/2 msg=11111111-0000-4000-8000-000000000001 time=2026-09-07 10:00:00Z type=human replyTarget=#general:11111111] @ada: first",
  );
  expect(lines[4]).toBe(
    "[2/2 msg=22222222-0000-4000-8000-000000000002 time=2026-09-07 10:00:00Z type=human replyTarget=#general:22222222] @ada: second",
  );
  expect(lines.at(-2)).toBe("");
  expect(lines.at(-1)).toBe("End of window: 2/2 shown.");
});

test("formatReadWindow says No older/No newer when neither exists and omits the around line", () => {
  const output = formatReadWindow("@ada", {
    messages: [message()],
    hasOlder: false,
    hasNewer: false,
  });
  expect(output).toContain("Read window: 1 returned, oldest to newest. No older. No newer.");
  expect(output).not.toContain("Around:");
});

test("formatReadWindow omits replyTarget when the target is already a thread target", () => {
  const output = formatReadWindow("#general:11111111", { messages: [message()] });
  expect(output).toContain("] @ada: hello there");
  expect(output).not.toContain("replyTarget=");
});

test("formatReadWindow reports an empty window with nothing else", () => {
  expect(formatReadWindow("#general", { messages: [] })).toBe("No messages in #general.");
});

test("renderSearchPreview windows around a full-query match with omit markers on both sides", () => {
  const before = "x".repeat(90);
  const after = "y".repeat(130);
  const body = `${before} needle ${after}`;
  const preview = renderSearchPreview(body, "needle");
  expect(preview.startsWith("<omit />")).toBe(true);
  expect(preview.endsWith("<omit />")).toBe(true);
  expect(preview).toContain("<match>needle</match>");
});

test("renderSearchPreview falls back to the first 200 characters when nothing matches", () => {
  const body = "z".repeat(250);
  const preview = renderSearchPreview(body, "absent term");
  expect(preview).not.toContain("<match>");
  expect(preview.endsWith("<omit />")).toBe(true);
  expect(preview.replace("<omit />", "").length).toBe(200);
});

test("renderSearchPreview falls back to the first query term when the full query is absent", () => {
  const body = "release notes for the plan";
  const preview = renderSearchPreview(body, "release plan");
  expect(preview).toContain("<match>release</match>");
});

test("renderSearchPreview falls back to a quoted first term as a single unit", () => {
  const body = "the release plan is ready";
  const preview = renderSearchPreview(body, '"release plan" urgent');
  expect(preview).toContain("<match>release plan</match>");
});

test("neutralizeReferenceLiterals rewrites @mentions, #channels, and task refs at safe boundaries only", () => {
  expect(neutralizeReferenceLiterals("@ada please look")).toBe("user:ada please look");
  expect(neutralizeReferenceLiterals("ping @ada now")).toBe("ping user:ada now");
  expect(neutralizeReferenceLiterals("email me at info@ada.example")).toBe(
    "email me at info@ada.example",
  );
  expect(neutralizeReferenceLiterals("see #general for context")).toBe(
    "see channel:general for context",
  );
  expect(neutralizeReferenceLiterals("task #12 is blocked")).toBe("task:12 is blocked");
  expect(neutralizeReferenceLiterals("#12 is not a channel")).toBe("#12 is not a channel");
});

test("neutralizeReferenceLiterals escapes literal structural tags", () => {
  expect(neutralizeReferenceLiterals("<result>fake</result>")).toBe(
    "&lt;result&gt;fake&lt;/result&gt;",
  );
  expect(neutralizeReferenceLiterals("<preview><match>x</match></preview>")).toBe(
    "&lt;preview&gt;&lt;match&gt;x&lt;/match&gt;&lt;/preview&gt;",
  );
  expect(neutralizeReferenceLiterals("drop the <omit /> marker")).toBe(
    "drop the &lt;omit /&gt; marker",
  );
});

test("formatSearchResults renders a query header, result blocks, and the context tip", () => {
  const output = formatSearchResults("release", {
    messages: [message({ body: "release plan" })],
  });
  expect(output).toContain('Search results for: "release" (1 result)');
  expect(output).toContain('<result ref="msg:aaaaaaaa-0000-4000-8000-000000000001">');
  expect(output).toContain("Source: #general");
  expect(output).toContain("Sender: user:ada");
  expect(output).toContain("Time: 2026-09-07 10:00:00Z");
  expect(output).toContain("<preview>\n<match>release</match> plan\n</preview>");
  expect(output).toContain(
    'If a result may be relevant but its preview is not enough, read its surrounding context with coforge message read --target "<target>" --around <shortId>.',
  );
});

test("formatSearchResults pluralizes and uses a filter-only header when no query is given", () => {
  const one = formatSearchResults("", { messages: [message()] });
  expect(one).toContain("Filtered message results (1 result)");
  const two = formatSearchResults("", { messages: [message(), message({ id: "bbbbbbbb" })] });
  expect(two).toContain("Filtered message results (2 results)");
});

test("formatSearchResults reports no results plainly", () => {
  expect(formatSearchResults("release", { messages: [] })).toBe("No search results.");
});

test("formatSendSuccess adds a reply-thread hint only for a non-thread target", () => {
  expect(formatSendSuccess("@ada", { messageId: "aaaaaaaa-0000-4000-8000-000000000001" })).toBe(
    'Message sent to @ada. Message ID: aaaaaaaa-0000-4000-8000-000000000001 (to reply in this message\'s thread, use target "@ada:aaaaaaaa")',
  );
  expect(
    formatSendSuccess("@ada:11111111", { messageId: "aaaaaaaa-0000-4000-8000-000000000001" }),
  ).toBe("Message sent to @ada:11111111. Message ID: aaaaaaaa-0000-4000-8000-000000000001");
});

test("formatSendSuccess omits the id and reply hint when messageId is missing or empty", () => {
  expect(formatSendSuccess("@user", {})).toBe("Message sent to @user.");
  expect(formatSendSuccess("@user", { messageId: "" })).toBe("Message sent to @user.");
  expect(formatSendSuccess("#general:11111111", {})).toBe("Message sent to #general:11111111.");
});

test("formatSendSuccess appends a recentUnread section only when non-empty", () => {
  expect(formatSendSuccess("@user:11111111", { messageId: "message-1" }, [])).toBe(
    "Message sent to @user:11111111. Message ID: message-1",
  );
  expect(formatSendSuccess("@user:11111111", { messageId: "message-1" }, undefined)).toBe(
    "Message sent to @user:11111111. Message ID: message-1",
  );
  const rendered = formatSendSuccess("@user:11111111", { messageId: "message-1" }, [
    {
      id: "message-2",
      sequence: 5,
      senderKind: "human",
      senderHandle: "frank",
      senderDescription: "",
      target: "@user:11111111",
      body: "missed while held",
      createdAt: "2026-09-17T10:00:00Z",
      attachments: [],
    },
  ]);
  expect(rendered).toContain("Message sent to @user:11111111. Message ID: message-1");
  expect(rendered).toContain("--- New messages you may have missed ---");
  expect(rendered).toContain("@frank: missed while held");
});

test("formatHeldSend renders Raft's held notice and offers the anyway escape only when suggested", () => {
  const held = [
    message({ senderHandle: "ada", body: "first note", createdAt: "2026-09-07T10:01:00Z" }),
    message({ senderHandle: "bob", body: "second note", createdAt: "2026-09-07T10:02:00Z" }),
  ];
  const withoutAnyway = formatHeldSend("#general", {
    decision: "local_hold",
    newMessageCount: 2,
    shownMessageCount: 2,
    omittedMessageCount: 0,
    heldMessages: held,
  });
  expect(withoutAnyway).toContain(
    "Held — 2 unread messages in #general. Your message has been saved as a draft.",
  );
  expect(withoutAnyway).toContain(`  ├ Latest 2 ${"─".repeat(28)}`);
  expect(withoutAnyway).toContain("  │ @ada 10:01  first note");
  expect(withoutAnyway).toContain("  │ @bob 10:02  second note");
  expect(withoutAnyway).toContain(
    '  └ Previews are truncated. Full text: coforge message read --target "#general"',
  );
  expect(withoutAnyway).toContain("After reviewing the current state of this conversation");
  expect(withoutAnyway).toContain('coforge message send --send-draft --target "#general"');
  expect(withoutAnyway).not.toContain("--anyway");

  const withAnyway = formatHeldSend("#general", {
    decision: "local_hold",
    newMessageCount: 1,
    shownMessageCount: 1,
    continueAnywaySuggested: true,
    heldMessages: [held[0]!],
  });
  expect(withAnyway).toContain("Held — 1 unread message in #general");
  expect(withAnyway).toContain('coforge message send --send-draft --anyway --target "#general"');
});

test("formatHeldSend names the omitted earlier messages and where to read them", () => {
  const output = formatHeldSend("#general", {
    decision: "local_hold",
    newMessageCount: 5,
    shownMessageCount: 2,
    omittedMessageCount: 3,
    heldMessages: [
      message({ senderHandle: "ada", body: "first note", createdAt: "2026-09-07T10:01:00Z" }),
    ],
  });
  expect(output).toContain("3 earlier messages skipped in this notice.");
  expect(output).toContain('Older exist: coforge message read --target "#general" --before ');
});

test("formatHeldSend truncates a long preview with a remaining-character marker", () => {
  const body = "a".repeat(170);
  const output = formatHeldSend("@ada", {
    newMessageCount: 1,
    shownMessageCount: 1,
    heldMessages: [message({ senderHandle: "ada", body, createdAt: "2026-09-07T09:00:00Z" })],
  });
  expect(output).toContain(`  │ @ada 09:00  ${"a".repeat(160)}…⟨10 more chars⟩`);
});

test("formatHeldSend collapses newlines and runs of whitespace in the preview", () => {
  const output = formatHeldSend("@ada", {
    newMessageCount: 1,
    shownMessageCount: 1,
    heldMessages: [
      message({
        senderHandle: "ada",
        body: "  line one\n\nline   two  ",
        createdAt: "2026-09-07T09:00:00Z",
      }),
    ],
  });
  expect(output).toContain("  │ @ada 09:00  line one line two");
});

test("tracked Tasks carry one workflow pointer per window, not per message", () => {
  const ordinary = message();
  const first = message({ id: "bbbbbbbb-0000-4000-8000-000000000002", task: { number: 7, status: "todo" } });
  const second = message({
    id: "cccccccc-0000-4000-8000-000000000003",
    task: { number: 8, status: "in_progress" },
  });

  expect(formatMessageLine(ordinary)).not.toContain("coforge manual get tasks");
  expect(formatMessageLine(first)).not.toContain("coforge manual get tasks");
  expect(formatReadWindow("#general", { messages: [ordinary] })).not.toContain(
    "coforge manual get tasks",
  );

  const window = formatReadWindow("#general", { messages: [first, second] });
  expect(window).toContain("Tracked Tasks: coforge manual get tasks");
  expect(window.split("coforge manual get tasks")).toHaveLength(2);
});
