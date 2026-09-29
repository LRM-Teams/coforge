import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskView } from "@lrm/coforge-sdk/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MessageBody } from "#src/features/conversations/message-body";
import { mentionHandlesByToken } from "#src/features/conversations/message-markdown";
import { ConversationIdProvider } from "#src/features/conversations/conversation-id";
import { conversationTasksFor } from "#src/features/tasks/use-conversation-tasks";
import { taskView } from "./fixtures/task-view";

const HUMAN_ID = "d9956ab1-9063-4182-8eab-861d1559c8ee";

const mentionOf = (kind: "user" | "agent", actorId: string, handle: string) => ({
  kind,
  actorId,
  handle,
  label: handle,
});

test("a stored mention token renders as a chip when the message carries its mention row", () => {
  const markup = renderToStaticMarkup(
    <MessageBody
      body={`<@human:${HUMAN_ID}> 三件事一起说`}
      mentions={[mentionOf("user", HUMAN_ID, "andong3-d9956ab1")]}
    />,
  );
  expect(markup).not.toContain("&lt;@human:");
  expect(markup).toContain("@andong3-d9956ab1");
});

test("a row for the person being mentioned is enough — nothing about them is special-cased", () => {
  // The #574 regression was in the *payload*: it dropped the viewer's own row from the
  // resolution directory, so "someone mentioning you" — the most common mention there is — was
  // exactly the one that leaked its raw `<@human:uuid>` token. This function has no notion of a
  // viewer, and that is the point: whoever the row describes, it resolves. The payload side is
  // pinned where it lives (`direct-conversation-repository.test.ts`: the pane's `mentionables`
  // contains the viewer's own row).
  const mentioned = mentionOf("user", HUMAN_ID, "andong3-d9956ab1");
  const handles = mentionHandlesByToken([mentioned]);
  expect(handles.has(`user:${HUMAN_ID}`)).toBe(true);
});

test("an unresolvable token degrades to literal text, never a phantom chip", () => {
  const markup = renderToStaticMarkup(
    <MessageBody body={`<@human:${HUMAN_ID}> 三件事一起说`} mentions={[]} />,
  );
  expect(markup).toContain("&lt;@human:");
  expect(markup).not.toContain("message-markdown-mention");
});

/** A body rendered inside a conversation whose Tasks hold `tasks`. */
function inConversation(node: ReactNode, tasks: TaskView[]) {
  const queryClient = new QueryClient();
  conversationTasksFor(queryClient, "conversation-1").apply([{ tasks, deleted: [] }]);
  return (
    <QueryClientProvider client={queryClient}>
      <ConversationIdProvider conversationId="conversation-1">{node}</ConversationIdProvider>
    </QueryClientProvider>
  );
}

const task68 = taskView(68, { messageId: "message-68", title: "Ship it", status: "in_progress" });

test("a stored task reference renders as its Task's status badge, never the raw token", () => {
  const markup = renderToStaticMarkup(
    inConversation(<MessageBody body={"pairs with <@task:68> today"} />, [task68]),
  );
  expect(markup).not.toContain("&lt;@task:");
  expect(markup).toContain(">#68<");
  expect(markup).toContain('data-task-status="in_progress"');
  // The ring is decorative, so the status is spelled out in the accessible name.
  expect(markup).toContain('aria-label="task #68, In progress"');
});

test("a referenced Task the conversation has becomes a control; any other number is plain text", () => {
  const clickable = renderToStaticMarkup(
    inConversation(<MessageBody body={"<@task:68>"} onOpenTask={() => {}} />, [task68]),
  );
  expect(clickable).toContain('role="button"');
  expect(clickable).toContain("cursor-pointer");

  // A token is a claim, checked against the conversation's Tasks: a number it has no Task for
  // reads as the words the author could have typed.
  const unknown = renderToStaticMarkup(
    inConversation(<MessageBody body={"<@task:69>"} onOpenTask={() => {}} />, [task68]),
  );
  expect(unknown).toContain(">task #69<");
  expect(unknown).not.toContain('role="button"');
  expect(unknown).not.toContain("data-task-status");

  // Outside a conversation (a search result, a Saved card) there are no Tasks to read.
  const outside = renderToStaticMarkup(<MessageBody body={"<@task:68>"} />);
  expect(outside).toContain(">task #68<");
  expect(outside).not.toContain("data-task-status");
});
