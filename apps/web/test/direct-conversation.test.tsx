import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DirectConversation,
  type DirectConversationView,
} from "@/features/conversations/direct-conversation";
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
) {
  render(
    <RouterContextProvider router={getRouter()}>
      <DirectConversation conversation={conversation} onSend={onSend} onRefresh={onRefresh} />
    </RouterContextProvider>,
  );
  return { page: within(document.body), onSend, onRefresh };
}

test("renders the empty private conversation", () => {
  const { page } = renderConversation();
  expect(page.getByRole("heading", { name: "Release Helper" })).toBeTruthy();
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
  const messages = page.getByRole("list").querySelectorAll("li");
  expect(messages[0]?.textContent).toContain("Please check");
  expect(messages[1]?.textContent).toContain("Checked");
  expect(messages[0]?.className).not.toBe(messages[1]?.className);
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

test("reuses a requestId after failure until the draft is edited or succeeds", async () => {
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
  await waitFor(() => expect(page.getByRole("alert")).toBeTruthy());
  const failedRequestId = onSend.mock.calls[0]![1];
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(composer.value).toBe(""));
  expect(onSend.mock.calls[1]![1]).toBe(failedRequestId);

  await user.type(composer, "second");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(page.getByRole("alert")).toBeTruthy());
  const secondFailedRequestId = onSend.mock.calls[2]![1];
  expect(secondFailedRequestId).not.toBe(failedRequestId);
  await user.type(composer, " edited");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(composer.value).toBe(""));
  expect(onSend.mock.calls[3]![1]).not.toBe(secondFailedRequestId);
});
