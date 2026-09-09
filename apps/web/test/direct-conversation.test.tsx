import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DirectConversation,
  type DirectConversationView,
  type OwnMessageIndexEntry,
} from "@/features/conversations/direct-conversation";
import { AppToastProvider } from "@/components/ui/toast";
import { ConversationLayout } from "@/features/conversations/conversation-layout";
import { getRouter } from "@/router";

afterEach(cleanup);

const base: DirectConversationView = {
  conversationId: "conversation-1",
  senderMemberId: "member-1",
  agent: {
    id: "agent-1",
    name: "release-helper",
    displayName: "Release Helper",
  },
  messages: [],
};

type ConversationSend = (
  body: string,
  requestId: string,
  attachmentId?: string,
  threadRootId?: string,
) => Promise<OwnMessageIndexEntry | void>;

function renderConversation(
  conversation = base,
  onSend: ConversationSend = mock(async (_body: string, _requestId: string) => {}),
  agentStatus: "active" | "inactive" = "active",
  onLoadOlder?: () => Promise<void>,
  onLoadOwnMessages?: (beforeSequence?: number) => Promise<{
    messages: Array<{
      id: string;
      sequence: number;
      body: string;
      createdAt: Date | string;
      attachmentFileName?: string;
    }>;
    hasOlder: boolean;
  }>,
  onLoadMessageAround?: (messageId: string) => Promise<void>,
  onShowLatest?: () => Promise<void>,
) {
  const view = render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <DirectConversation
          conversation={conversation}
          agentStatus={agentStatus}
          onSend={onSend}
          onLoadOlder={onLoadOlder}
          onLoadOwnMessages={onLoadOwnMessages}
          onLoadMessageAround={onLoadMessageAround}
          onShowLatest={onShowLatest}
        />
      </AppToastProvider>
    </RouterContextProvider>,
  );
  return {
    page: within(document.body),
    onSend,
    rerender(nextConversation: DirectConversationView) {
      view.rerender(
        <RouterContextProvider router={getRouter()}>
          <AppToastProvider>
            <DirectConversation
              conversation={nextConversation}
              agentStatus={agentStatus}
              onSend={onSend}
              onLoadOlder={onLoadOlder}
              onLoadOwnMessages={onLoadOwnMessages}
              onLoadMessageAround={onLoadMessageAround}
              onShowLatest={onShowLatest}
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
  expect(history.className).toContain("overflow-y-auto");
  expect(history.className).toContain("[scrollbar-width:none]");
  expect(history.className).toContain("[&::-webkit-scrollbar]:hidden");
  expect(history.querySelectorAll("[data-message]")).toHaveLength(1);
  history.scrollTop = 123;
  const mainComposer = page.getByLabelText("Message") as HTMLTextAreaElement;
  await user.type(mainComposer, "main draft");
  const threadButton = page.getByRole("button", { name: /1 reply/ });
  expect(threadButton.textContent).toContain("1 reply");
  expect(threadButton.closest("[data-message]")?.textContent).toContain(root.body);
  expect(threadButton.querySelector("svg")).toBeTruthy();
  await user.click(threadButton);
  expect(calls).toEqual([]);
  const discussion = within(page.getByRole("region", { name: "Thread" }));
  const threadHistory = discussion.getByLabelText("Thread");
  expect(threadHistory.className).toContain("overflow-y-auto");
  expect(threadHistory.className).toContain("[scrollbar-width:none]");
  expect(threadHistory.className).toContain("[&::-webkit-scrollbar]:hidden");
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

test("summarizes a thread and previews only its latest three replies", async () => {
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
  const openThread = within(preview).getByRole("button", { name: "4 replies" });
  const replies = within(preview).getAllByRole("listitem");
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
  await user.click(openThread);
  const discussion = within(page.getByRole("region", { name: "Thread" }));
  expect(discussion.getByText("Reply 2")).toBeTruthy();
  expect(discussion.getByText("Reply 5")).toBeTruthy();
});

test("renders the empty private conversation", () => {
  const { page, rerender } = renderConversation();
  expect(page.getByRole("heading", { name: "Release Helper" })).toBeTruthy();
  expect(
    page.getByRole("button", {
      name: "Release Helper, Online, Recent activity",
    }),
  ).toBeTruthy();
  expect(page.getByText("@release-helper")).toBeTruthy();
  const history = within(page.getByLabelText("Message history"));
  expect(history.getByRole("heading", { name: "Chat with Release Helper" })).toBeTruthy();
  expect(page.getAllByRole("textbox", { name: "Message" })).toHaveLength(1);
  expect(page.queryByRole("link", { name: /Back to messages/i })).toBeNull();
  rerender({ ...base, messages: [firstMessage] });
  expect(history.queryByRole("heading", { name: "Chat with Release Helper" })).toBeNull();
  expect(page.getByText("Please check")).toBeTruthy();
});

test("empty thread keeps its root and reply composer instead of the private-chat introduction", async () => {
  const { page } = renderConversation({ ...base, messages: [firstMessage] });
  await userEvent.setup().click(page.getByRole("button", { name: "Reply in thread" }));
  const thread = within(page.getByRole("region", { name: "Thread" }));
  expect(thread.getByRole("heading", { name: "No replies yet", level: 3 })).toBeTruthy();
  expect(thread.getByLabelText("Original message").textContent).toContain("Please check");
  expect(thread.getByRole("textbox", { name: "Message" })).toBeTruthy();
  expect(thread.queryByText("Chat with Release Helper")).toBeNull();
});

test("shared chat activity updates header and sidebar, with matching hover dots", async () => {
  const entry = {
    launchId: "launch",
    clientSeq: 1,
    detailKind: "running_command",
    level: "info",
    detail: "",
    observedAtMs: Date.now(),
  };
  const agent = {
    ...base.agent,
    status: { value: "active" as const, expiresAt: Date.now() + 60_000 },
  };
  const refresh = async () => {};
  const tree = (activity: (typeof entry)[]) => (
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <ConversationLayout
          agents={[agent]}
          selectedAgentId={agent.id}
          activityView={{
            activity: { [agent.id]: activity },
            loading: false,
            error: false,
          }}
        >
          <DirectConversation conversation={base} agentStatus="active" onSend={refresh} />
        </ConversationLayout>
      </AppToastProvider>
    </RouterContextProvider>
  );
  const view = render(tree([entry]));
  const page = within(document.body);
  expect(page.getByRole("status").textContent).toBe("Running command…");
  const avatars = page.getAllByRole("button", {
    name: /Release Helper, Online, Running command/,
  });
  expect(avatars).toHaveLength(2);
  expect(avatars.every((avatar) => avatar.querySelector(".bg-amber-500"))).toBe(true);
  expect(document.querySelector("a button")).toBeNull();
  fireEvent.click(avatars[0]!);
  const popup = await page.findByRole("dialog");
  expect(popup.querySelector("li .bg-amber-500")).not.toBeNull();
  view.rerender(tree([{ ...entry, clientSeq: 2, detailKind: "idle" }]));
  expect(document.querySelector("header [role=status]")).toBeNull();
  expect(document.querySelector("button[data-working=true]")).toBeNull();
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
  expect(page.getByText("Please check").className).toContain("max-w-[85%]");
  expect(page.getByText("Checked").className).not.toContain("max-w-[85%]");
});

test("wraps an unbroken message inside its bubble", () => {
  const body = "INDEX_REFRESH_1725_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const { page } = renderConversation({
    ...base,
    messages: [{ ...firstMessage, body }],
  });

  const bubble = page.getByText(body);
  expect(bubble.className).toContain("[overflow-wrap:anywhere]");
});

test("keeps large histories to a bounded number of mounted message rows", async () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    value: 600,
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return new DOMRect(
      0,
      0,
      390,
      this.getAttribute("aria-label") === "Message history" ? 600 : 120,
    );
  };

  try {
    const { page } = renderConversation({
      ...base,
      messages: Array.from({ length: 250 }, (_, index) => ({
        ...firstMessage,
        id: `message-${index + 1}`,
        sequence: index + 1,
        body: `Message ${index + 1}`,
      })),
    });
    const history = page.getByLabelText("Message history");

    await waitFor(() => {
      const mountedMessages = history.querySelectorAll("[data-message]");
      expect(mountedMessages.length).toBeGreaterThan(0);
      expect(mountedMessages.length).toBeLessThan(30);
      expect(history.querySelector("ol")?.style.height).not.toBe("");
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = getBoundingClientRect;
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  }
});

test("loads an older page once when the reader reaches the top", async () => {
  const pending = Promise.withResolvers<void>();
  const onLoadOlder = mock(() => pending.promise);
  const { page } = renderConversation(
    { ...base, hasOlder: true, messages: [firstMessage] },
    undefined,
    "active",
    onLoadOlder,
  );
  const history = page.getByLabelText("Message history");
  Object.defineProperty(history, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });

  fireEvent.scroll(history);
  fireEvent.scroll(history);

  expect(onLoadOlder).toHaveBeenCalledTimes(1);
  expect(
    page.getByRole("button", { name: "Loading older messages…" }).hasAttribute("disabled"),
  ).toBe(true);
  pending.resolve();
  await waitFor(() =>
    expect(page.getByRole("button", { name: "Load older messages" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
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

test("keeps sent-message navigation available while following the latest message", () => {
  const { page } = renderConversation({ ...base, messages: [firstMessage] });

  expect(page.getByRole("button", { name: "Your messages" })).toBeTruthy();
  expect(page.queryByRole("button", { name: "Back to bottom" })).toBeNull();
});

test("returns to the latest message after the reader scrolls up", async () => {
  const user = userEvent.setup();
  const { page } = renderConversation({ ...base, messages: [firstMessage] });
  const history = page.getByLabelText("Message history");
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });

  fireEvent.scroll(history);

  const backToBottom = page.getByRole("button", { name: "Back to bottom" });
  await user.click(backToBottom);

  expect(history.scrollTop).toBe(1_000);
  expect(page.queryByRole("button", { name: "Back to bottom" })).toBeNull();
});

test("navigates loaded own messages from the floating history controls", async () => {
  const user = userEvent.setup();
  const { page } = renderConversation({
    ...base,
    messages: [
      { ...firstMessage, id: "three", sequence: 3, body: "Latest prompt" },
      {
        ...firstMessage,
        id: "two",
        sequence: 2,
        senderKind: "agent",
        senderName: "Release Helper",
        body: "Agent answer",
      },
      { ...firstMessage, body: "First prompt" },
    ],
  });
  const history = page.getByLabelText("Message history");
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  fireEvent.scroll(history);

  const controls = page.getByRole("group", { name: "Message navigation" });
  expect(within(controls).getByRole("button", { name: "Back to bottom" })).toBeTruthy();
  await user.click(within(controls).getByRole("button", { name: "Your messages" }));

  const menu = within(page.getByRole("menu"));
  expect(menu.getByText("First prompt")).toBeTruthy();
  expect(menu.getByText("Latest prompt")).toBeTruthy();
  expect(menu.queryByText("Agent answer")).toBeNull();
  expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    expect.stringContaining("First prompt"),
    expect.stringContaining("Latest prompt"),
  ]);
  const scrollTo = mock(() => {});
  history.scrollTo = scrollTo;
  await user.click(menu.getByRole("menuitem", { name: /First prompt/ }));
  expect(scrollTo).toHaveBeenCalled();
});

test("expands and collapses a compact day separator", async () => {
  const user = userEvent.setup();
  const { page } = renderConversation({ ...base, messages: [firstMessage] });

  const compactDate = page.getByRole("button", { name: "Saturday" });
  expect(compactDate.getAttribute("aria-expanded")).toBe("false");
  expect(compactDate.className).toContain("cursor-pointer");

  await user.click(compactDate);
  const fullDate = page.getByRole("button", {
    name: "Saturday, August 29, 2026",
  });
  expect(fullDate.getAttribute("aria-expanded")).toBe("true");

  await user.click(fullDate);
  expect(page.getByRole("button", { name: "Saturday" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
});

test("keeps older loaded sent messages available in navigation", async () => {
  const user = userEvent.setup();
  const { page } = renderConversation({
    ...base,
    messages: Array.from({ length: 6 }, (_, index) => ({
      ...firstMessage,
      id: `message-${index + 1}`,
      sequence: index + 1,
      body: `Prompt ${index + 1}`,
    })),
  });
  const history = page.getByLabelText("Message history");
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  fireEvent.scroll(history);

  await user.click(page.getByRole("button", { name: "Your messages" }));

  const menu = within(page.getByRole("menu"));
  expect(menu.getByRole("menuitem", { name: /Prompt 1/ })).toBeTruthy();
  expect(menu.getByRole("menuitem", { name: /Prompt 6/ })).toBeTruthy();
});

test("prefetches the own-message index on entry and prepends older cursor pages", async () => {
  const user = userEvent.setup();
  const onLoadOwnMessages = mock(async (beforeSequence?: number) =>
    beforeSequence
      ? {
          hasOlder: false,
          messages: [30, 40].map((sequence) => ({
            id: `indexed-${sequence}`,
            sequence,
            body: `Indexed prompt ${sequence}`,
            createdAt: new Date(sequence * 1_000).toISOString(),
          })),
        }
      : {
          hasOlder: true,
          messages: [50, 60].map((sequence) => ({
            id: `indexed-${sequence}`,
            sequence,
            body: `Indexed prompt ${sequence}`,
            createdAt: new Date(sequence * 1_000).toISOString(),
          })),
        },
  );
  const { page } = renderConversation(base, undefined, "active", undefined, onLoadOwnMessages);

  await waitFor(() => expect(onLoadOwnMessages).toHaveBeenCalledWith(undefined));
  await user.click(page.getByRole("button", { name: "Your messages" }));
  const menu = within(page.getByRole("menu"));
  await waitFor(() => expect(menu.getAllByRole("menuitem")).toHaveLength(2));
  expect(onLoadOwnMessages).toHaveBeenCalledTimes(1);
  expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    expect.stringContaining("Indexed prompt 50"),
    expect.stringContaining("Indexed prompt 60"),
  ]);

  fireEvent.scroll(page.getByRole("menu"), { target: { scrollTop: 0 } });

  await waitFor(() => expect(menu.getAllByRole("menuitem")).toHaveLength(4));
  expect(onLoadOwnMessages).toHaveBeenLastCalledWith(50);
  expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    expect.stringContaining("Indexed prompt 30"),
    expect.stringContaining("Indexed prompt 40"),
    expect.stringContaining("Indexed prompt 50"),
    expect.stringContaining("Indexed prompt 60"),
  ]);
});

test("shows immediate feedback while the own-message index is loading", async () => {
  let resolvePage: ((page: { messages: []; hasOlder: false }) => void) | undefined;
  const onLoadOwnMessages = mock(
    () =>
      new Promise<{ messages: []; hasOlder: false }>((resolve) => {
        resolvePage = resolve;
      }),
  );
  const { page } = renderConversation(base, undefined, "active", undefined, onLoadOwnMessages);

  await userEvent.setup().click(page.getByRole("button", { name: "Your messages" }));

  expect(page.getByRole("status", { name: "Loading your messages…" })).toBeTruthy();
  await act(async () => resolvePage?.({ messages: [], hasOlder: false }));
  await waitFor(() =>
    expect(page.queryByRole("status", { name: "Loading your messages…" })).toBeNull(),
  );
});

test("loads an around window before navigating to an indexed message outside history", async () => {
  const user = userEvent.setup();
  const indexedMessage = {
    id: "00000000-0000-4000-8000-000000000009",
    sequence: 9,
    body: "Indexed old prompt",
    createdAt: "2026-08-29T09:00:00Z",
  };
  const onLoadMessageAround = mock(async (_messageId: string) => {});
  const onShowLatest = mock(async () => {});
  const { page, rerender } = renderConversation(
    { ...base, messages: [{ ...firstMessage, id: "latest", sequence: 100 }] },
    undefined,
    "active",
    undefined,
    async () => ({ messages: [indexedMessage], hasOlder: false }),
    onLoadMessageAround,
    onShowLatest,
  );
  const history = page.getByLabelText("Message history");
  const scrollTo = mock(() => {});
  history.scrollTo = scrollTo;

  await user.click(page.getByRole("button", { name: "Your messages" }));
  await user.click(await page.findByRole("menuitem", { name: /Indexed old prompt/ }));

  expect(onLoadMessageAround).toHaveBeenCalledWith(indexedMessage.id);
  rerender({
    ...base,
    hasOlder: true,
    hasNewer: true,
    messages: [{ ...firstMessage, ...indexedMessage }],
  });
  await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  expect(page.getByText("Indexed old prompt")).toBeTruthy();
  await user.click(page.getByRole("button", { name: "Back to bottom" }));
  expect(onShowLatest).toHaveBeenCalledTimes(1);
  scrollTo.mockClear();
  rerender({
    ...base,
    hasOlder: true,
    hasNewer: false,
    messages: [firstMessage],
  });
  await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  expect(page.queryByRole("button", { name: "Back to bottom" })).toBeNull();
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
  const newMessages = await page.findByRole("button", {
    name: "2 new messages",
  });
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

test("adds a sent message to the own-message navigation index immediately", async () => {
  const user = userEvent.setup();
  const onLoadOwnMessages = mock(async () => ({
    messages: [],
    hasOlder: false,
  }));
  const onSend = mock(async (body: string, _requestId: string) => ({
    id: "sent-message",
    sequence: 2,
    body,
    createdAt: "2026-08-29T10:02:00Z",
  }));
  const { page } = renderConversation(base, onSend, "active", undefined, onLoadOwnMessages);

  await waitFor(() => expect(onLoadOwnMessages).toHaveBeenCalledWith(undefined));
  await user.type(page.getByLabelText("Message"), "hi");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect((page.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(""),
  );
  await user.click(page.getByRole("button", { name: "Your messages" }));

  expect(within(page.getByRole("menu")).getByRole("menuitem", { name: /hi/ })).toBeTruthy();
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
  // Repeated safe feedback updates one toast; request identity still belongs
  // to each draft independently of notification deduplication.
  await waitFor(() =>
    expect(
      page.getByRole("region", { name: "Notifications" }).textContent?.match(/could not/g)?.length,
    ).toBe(1),
  );
  const secondFailedRequestId = onSend.mock.calls[2]![1];
  expect(secondFailedRequestId).not.toBe(failedRequestId);
  await user.type(composer, " edited");
  await user.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(composer.value).toBe(""));
  expect(onSend.mock.calls[3]![1]).not.toBe(secondFailedRequestId);
});
