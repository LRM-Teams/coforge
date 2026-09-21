import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageBody } from "@/features/conversations/message-body";
import { mentionHandlesByToken } from "@/features/conversations/message-markdown";

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
