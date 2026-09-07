import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DirectConversation,
  type DirectConversationView,
} from "@/features/conversations/direct-conversation";
import { AppToastProvider } from "@/components/ui/toast";
import { getRouter } from "@/router";

afterEach(cleanup);

const base: DirectConversationView = {
  conversationId: "conversation-1",
  senderMemberId: "member-1",
  agent: { id: "agent-1", name: "release-helper", displayName: "Release Helper" },
  messages: [],
};

function renderConversation(
  conversation = base,
  onSend = mock(async (_body: string, _requestId: string) => {}),
  onRefresh = mock(async () => {}),
  agentStatus: "active" | "inactive" = "active",
) {
  const view = render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <DirectConversation
          conversation={conversation}
          agentStatus={agentStatus}
          onSend={onSend}
          onRefresh={onRefresh}
        />
      </AppToastProvider>
    </RouterContextProvider>,
  );
  return {
    page: within(document.body),
    onSend,
    onRefresh,
    rerender(nextConversation: DirectConversationView) {
      view.rerender(
        <RouterContextProvider router={getRouter()}>
          <AppToastProvider>
            <DirectConversation
              conversation={nextConversation}
              agentStatus={agentStatus}
              onSend={onSend}
              onRefresh={onRefresh}
            />
          </AppToastProvider>
        </RouterContextProvider>,
      );
    },
  };
}

const firstMessage: DirectConversationView["messages"][number] = {
  id: "one",
  sequence: 1,
  senderKind: "user",
  senderName: "Frank",
  body: "Please check",
  createdAt: "2026-08-29T10:00:00Z",
};

test("thread replies stay out of main history and preserve separate drafts and main scroll", async () => {
  const user = userEvent.setup();
  const calls: unknown[][] = [];
  const onSend = mock(async (...args: [string, string, string?, string?]) => {
    calls.push(args);
  });
  const root = { ...firstMessage, id: "12345678-0000-4000-8000-000000000001" };
  const { page } = renderConversation(
    {
      ...base,
      messages: [
        root,
        {
          ...firstMessage,
          id: "reply",
          sequence: 2,
          threadRootId: root.id,
          senderKind: "agent",
          body: "Only in discussion",
        },
      ],
    },
    onSend,
  );
  const history = page.getByLabelText("Message history");
  expect(history.querySelectorAll("[data-message]")).toHaveLength(1);
  history.scrollTop = 123;
  const mainComposer = page.getByLabelText("Message") as HTMLTextAreaElement;
  await user.type(mainComposer, "main draft");
  const threadButton = page.getByRole("button", { name: /1 reply/ });
  expect(threadButton.textContent).toBe("1");
  expect(threadButton.parentElement?.textContent).toContain(root.body);
  expect(threadButton.querySelector("svg")).toBeTruthy();
  await user.click(threadButton);
  expect(calls).toEqual([]);
  const discussion = within(page.getByRole("region", { name: "Thread" }));
  expect(discussion.queryByText(/Original message/)).toBeNull();
  expect(discussion.getByText("Only in discussion")).toBeTruthy();
  expect(discussion.queryByRole("button", { name: "Reply in thread" })).toBeNull();
  await user.type(discussion.getByLabelText("Message"), "thread draft");
  await user.click(discussion.getByRole("button", { name: "Back to chat" }));
  expect(mainComposer.value).toBe("main draft");
  expect(history.scrollTop).toBe(123);
  await user.click(page.getByRole("button", { name: /1 reply/ }));
  await user.click(discussion.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(calls[0]?.[3]).toBe(root.id));
  expect(calls[0]?.[0]).toBe("thread draft");
});

test("previews only the latest three thread replies in chronological order", async () => {
  const user = userEvent.setup();
  const { page } = renderConversation({
    ...base,
    messages: [
      firstMessage,
      ...[2, 3, 4, 5].map((sequence) => ({
        ...firstMessage,
        id: `reply-${sequence}`,
        sequence,
        threadRootId: firstMessage.id,
        body: `Reply ${sequence}`,
      })),
      { ...firstMessage, id: "empty-root", sequence: 6, body: "No replies" },
    ],
  });
  const preview = page.getByRole("group", { name: "Thread" });
  const replies = within(preview).getAllByRole("button");
  expect(replies.map((reply) => within(reply).getByText(/Reply/).textContent)).toEqual([
    "Reply 3",
    "Reply 4",
    "Reply 5",
  ]);
  expect(
    replies.every(
      (reply) =>
        reply.querySelector("time")?.dateTime === new Date(firstMessage.createdAt).toISOString(),
    ),
  ).toBe(true);
  expect(page.queryByText("Reply 2")).toBeNull();
  await user.click(replies[0]!);
  const discussion = within(page.getByRole("region", { name: "Thread" }));
  expect(discussion.getByText("Reply 2")).toBeTruthy();
  expect(discussion.getByText("Reply 5")).toBeTruthy();
});

test("renders the empty private conversation", () => {
  const { page } = renderConversation();
  expect(page.getByRole("heading", { name: "Release Helper" })).toBeTruthy();
  expect(page.getByLabelText("Release Helper, Online")).toBeTruthy();
  expect(page.getByText("@release-helper")).toBeTruthy();
  expect(page.getByText("No messages yet")).toBeTruthy();
  expect(page.queryByRole("link", { name: /Back to messages/i })).toBeNull();
});

test("renders persisted messages in sequence order with distinct senders", () => {
  const { page } = renderConversation({
    ...base,
    messages: [
      {
        id: "one",
        sequence: 1,
        senderKind: "user",
        senderName: "Frank",
        body: "Please check",
        createdAt: "2026-08-29T10:00:00Z",
      },
      {
        id: "two",
        sequence: 2,
        senderKind: "agent",
        senderName: "Release Helper",
        body: "Checked",
        createdAt: "2026-08-29T10:00:01Z",
      },
    ],
  });
  const messages = page.getByRole("list").querySelectorAll("[data-message]");
  expect(messages[0]?.textContent).toContain("Please check");
  expect(messages[1]?.textContent).toContain("Checked");
  // Every bubble now shares one surface, so the sides are told apart by
  // authorship: the viewer's own message is labelled and carries no avatar.
  expect(messages[0]?.getAttribute("data-message")).toBe("own");
  expect(messages[1]?.getAttribute("data-message")).toBe("other");
  expect(messages[0]?.textContent).toContain("You");
  expect(messages[0]?.querySelector(":scope > [aria-hidden]")).toBeNull();
  expect(messages[1]?.querySelector(":scope > [aria-hidden]")).toBeTruthy();
  expect(messages[1]?.textContent).toContain("Release Helper");
});

test("renders an attachment as a downloadable history link", () => {
  const { page } = renderConversation({
    ...base,
    messages: [
      {
        id: "one",
        sequence: 1,
        senderKind: "user",
        senderName: "Frank",
        body: "See attached",
        createdAt: "2026-08-29T10:00:00Z",
        attachment: {
          id: "attachment-1",
          fileName: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: 2048,
        },
      },
    ],
  });
  const link = page.getByRole("link", { name: /report\.pdf/ });
  expect(link.getAttribute("href")).toBe("/api/attachments/attachment-1");
});

test("mounts an overflowing conversation at the latest message", () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
  });

  const { page } = renderConversation({ ...base, messages: [firstMessage] });
  const history = page.getByLabelText("Message history");

  expect(history.scrollTop).toBe(1_000);
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
});

test("announces one new Agent message and clears it when manually scrolled to latest", async () => {
  const conversation = { ...base, messages: [firstMessage] };
  const { page, rerender } = renderConversation(conversation);
  const history = page.getByLabelText("Message history");
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  fireEvent.scroll(history);

  rerender({
    ...conversation,
    messages: [
      firstMessage,
      {
        ...firstMessage,
        id: "two",
        sequence: 2,
        senderKind: "agent",
        senderName: "Release Helper",
        body: "Checked",
      },
    ],
  });
  expect(await page.findByRole("button", { name: "1 new message" })).toBeTruthy();

  history.scrollTop = 600;
  fireEvent.scroll(history);

  expect(page.queryByRole("button", { name: /new messages?/i })).toBeNull();
});

test("keeps the reading position and announces a new message while viewing history", async () => {
  const user = userEvent.setup();
  const conversation = { ...base, messages: [firstMessage] };
  const { page, rerender } = renderConversation(conversation);
  const history = page.getByLabelText("Message history");
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  fireEvent.scroll(history);

  const ownMessage = {
    ...firstMessage,
    id: "two",
    sequence: 2,
    body: "One more thing",
  };
  rerender({ ...conversation, messages: [firstMessage, ownMessage] });
  expect(page.queryByRole("button", { name: /new messages?/i })).toBeNull();

  rerender({
    ...conversation,
    messages: [
      firstMessage,
      ownMessage,
      {
        id: "three",
        sequence: 3,
        senderKind: "agent",
        senderName: "Release Helper",
        body: "Checked",
        createdAt: "2026-08-29T10:00:01Z",
      },
      {
        id: "four",
        sequence: 4,
        senderKind: "agent",
        senderName: "Release Helper",
        body: "Anything else?",
        createdAt: "2026-08-29T10:00:02Z",
      },
    ],
  });

  expect(history.scrollTop).toBe(100);
  const newMessages = await page.findByRole("button", { name: "2 new messages" });
  await user.click(newMessages);
  expect(history.scrollTop).toBe(1_000);
  expect(page.queryByRole("button", { name: "2 new messages" })).toBeNull();
});

test("follows new messages while at the latest message", () => {
  const conversation = { ...base, messages: [firstMessage] };
  const { page, rerender } = renderConversation(conversation);
  const history = page.getByLabelText("Message history");
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 600 },
  });
  fireEvent.scroll(history);
  history.scrollTop = 500;

  rerender({
    ...conversation,
    messages: [
      firstMessage,
      {
        ...firstMessage,
        id: "two",
        sequence: 2,
        senderKind: "agent",
        senderName: "Release Helper",
        body: "Checked",
      },
    ],
  });

  expect(history.scrollTop).toBe(1_000);
  expect(page.queryByRole("button", { name: /new messages?/i })).toBeNull();
});

test("starts a different conversation at its latest message", () => {
  const conversation = { ...base, messages: [firstMessage] };
  const { page, rerender } = renderConversation(conversation);
  const history = page.getByLabelText("Message history");
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  fireEvent.scroll(history);

  rerender({
    ...base,
    conversationId: "conversation-2",
    agent: { id: "agent-2", name: "reviewer", displayName: "Reviewer" },
    messages: [{ ...firstMessage, id: "other-one", body: "New conversation" }],
  });

  expect(history.scrollTop).toBe(1_000);
  expect(page.queryByRole("button", { name: /new messages?/i })).toBeNull();
});

test("sends trimmed text and clears only after success", async () => {
  const user = userEvent.setup();
  const onSend = mock(async (_body: string, _requestId: string) => {});
  const { page } = renderConversation(base, onSend);
  const composer = page.getByLabelText("Message") as HTMLTextAreaElement;
  await user.type(composer, "  hello Agent  ");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onSend).toHaveBeenCalled());
  expect(onSend.mock.calls[0]?.[0]).toBe("hello Agent");
  expect(onSend.mock.calls[0]?.[1]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await waitFor(() => expect(composer.value).toBe(""));
});

test("Enter sends, Shift+Enter keeps the draft, and sending prevents duplicates", async () => {
  const user = userEvent.setup();
  let finish = () => {};
  const onSend = mock(
    (_body: string, _requestId: string) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { page } = renderConversation(base, onSend);
  const composer = page.getByLabelText("Message") as HTMLTextAreaElement;
  await user.type(composer, "line one");
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(onSend).not.toHaveBeenCalled();
  expect(composer.value).toBe("line one\n");
  await user.keyboard("{Enter}{Enter}");
  await waitFor(() =>
    expect(page.getByRole("button", { name: "Sending…" }).hasAttribute("disabled")).toBe(true),
  );
  expect(onSend).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(composer.value).toBe(""));
});

test("shows a safe toast and reuses a requestId after failure until the draft changes", async () => {
  const user = userEvent.setup();
  let attempt = 0;
  const onSend = mock(async (_body: string, _requestId: string) => {
    attempt += 1;
    if (attempt === 1 || attempt === 3) throw new Error("temporary failure");
  });
  const { page } = renderConversation(base, onSend);
  const composer = page.getByLabelText("Message") as HTMLTextAreaElement;

  await user.type(composer, "first");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(page.getByRole("region", { name: "Notifications" }).textContent).toContain(
      "The message could not be sent. Try again.",
    ),
  );
  expect(document.body.textContent).not.toContain("temporary failure");
  const failedRequestId = onSend.mock.calls[0]![1];
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(composer.value).toBe(""));
  expect(onSend.mock.calls[1]![1]).toBe(failedRequestId);

  await user.type(composer, "second");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(
      page.getByRole("region", { name: "Notifications" }).textContent?.match(/could not/g)?.length,
    ).toBe(2),
  );
  const secondFailedRequestId = onSend.mock.calls[2]![1];
  expect(secondFailedRequestId).not.toBe(failedRequestId);
  await user.type(composer, " edited");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(composer.value).toBe(""));
  expect(onSend.mock.calls[3]![1]).not.toBe(secondFailedRequestId);
});
