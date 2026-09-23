import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationPane } from "#src/features/conversations/direct-conversation";
import { m } from "#src/paraglide/messages";

/**
 * The thread pane used to draw its root as a bespoke display-only block, so the root message
 * had none of the affordances an ordinary row has: no hover toolbar / tap action sheet, no
 * reactions, no action card, no quote-selection. These tests pin the root being rendered as a
 * real MessageRow (its own `data-message-id` li), with the action affordances present.
 */

const rootMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  sequence: 10,
  senderKind: "agent" as const,
  senderName: "atlas",
  senderHandle: "atlas",
  senderAgentId: "agent-atlas",
  body: "A very long status report that fills the thread pane. ".repeat(3),
  createdAt: "2026-09-21T07:00:00.000Z",
  attachments: [],
  reactions: [{ emoji: "👍", count: 2, reactors: ["@casey-morgan", "@dev-user"] }],
};

const replyMessage = {
  id: "22222222-2222-4222-8222-222222222222",
  sequence: 11,
  threadRootId: rootMessage.id,
  senderKind: "user" as const,
  senderMemberId: "member-user-1",
  senderName: "Dev User",
  senderHandle: "dev-user",
  body: "Thanks, reading now.",
  createdAt: "2026-09-21T07:05:00.000Z",
  attachments: [],
};

function renderThreadPane() {
  const markup = renderToStaticMarkup(
    <ConversationPane
      conversation={{
        conversationId: "conv-1",
        senderMemberId: "member-user-1",
        readThroughSequence: 11,
        viewerHandle: "dev-user",
        messages: [replyMessage],
      }}
      root={rootMessage}
      emptyState={{
        title: m.conversation_thread_empty_title(),
        description: m.conversation_thread_empty(),
        media: null,
      }}
      onSend={async () => {}}
      onToggleReaction={async () => {}}
    />,
  );
  return markup;
}

/** The root region is the subtree that starts at the thread-root landmark. */
function rootRegion(markup: string) {
  const start = markup.indexOf(m.conversation_thread_root());
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = markup.slice(start);
  // The replies list follows the root region; cap the region at it.
  const repliesAt = rest.indexOf(replyMessage.id);
  return repliesAt >= 0 ? rest.slice(0, repliesAt) : rest;
}

test("the thread root renders as a real message row, not a display-only block", () => {
  const region = rootRegion(renderThreadPane());
  expect(region).toContain("<li");
  expect(region).toContain(`data-message-id="${rootMessage.id}"`);
});

test("the thread root carries the message action affordances (reaction picker, copy)", () => {
  const region = rootRegion(renderThreadPane());
  expect(region).toContain(m.conversation_add_reaction());
  expect(region).toContain(m.conversation_message_copy_text());
});

test("the thread root shows its reactions", () => {
  const region = rootRegion(renderThreadPane());
  expect(region).toContain("👍 2");
});

test("the thread root offers no thread entry of its own (the pane is already its thread)", () => {
  const region = rootRegion(renderThreadPane());
  expect(region).not.toContain(m.conversation_thread_reply());
});

test("replies still render as their own rows below the root", () => {
  const markup = renderThreadPane();
  expect(markup).toContain(`data-message-id="${replyMessage.id}"`);
  expect(markup).toContain("Thanks, reading now.");
});
