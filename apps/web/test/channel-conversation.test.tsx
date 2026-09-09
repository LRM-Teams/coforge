import "./dom-setup";
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelConversation } from "@/features/conversations/channel-conversation";
import { AppToastProvider } from "@/components/ui/toast";

afterEach(cleanup);

const history = {
  conversationId: "channel-1",
  name: "engineering",
  senderMemberId: "alice-member",
  muted: false,
  messages: [
    {
      id: "a",
      sequence: 1,
      senderMemberId: "alice-member",
      senderKind: "user" as const,
      senderName: "@alice",
      body: "Hello Bob",
      createdAt: "2026-09-06T10:00:00Z",
    },
    {
      id: "b",
      sequence: 2,
      senderMemberId: "bob-member",
      senderKind: "user" as const,
      senderName: "@bob",
      body: "Hello Alice",
      createdAt: "2026-09-06T10:01:00Z",
    },
  ],
};

test("channel identifies the current human, not every human, as You", async () => {
  const onSend = mock(async () => {});
  const onMutedChange = mock(async () => {});
  render(
    <AppToastProvider>
      <ChannelConversation
        conversation={history}
        onSend={onSend}
        onJoin={async () => {}}
        onMutedChange={onMutedChange}
      />
      <ChannelConversation
        conversation={{ ...history, senderMemberId: "" }}
        onSend={onSend}
        onJoin={async () => {}}
        onMutedChange={onMutedChange}
      />
    </AppToastProvider>,
  );
  const page = within(document.body);
  expect(page.getAllByRole("heading", { name: "#engineering" })).toHaveLength(2);
  const own = document.querySelector('[data-message="own"]')!;
  const other = document.querySelector('[data-message="other"]')!;
  expect(own.textContent).toContain("You");
  expect(other.textContent).toContain("@bob");
  expect(other.textContent).not.toContain("You");
  expect(document.querySelector("#message-b")).toBe(other);
  expect(other.className).toContain("target:ring-2");
  expect(page.getAllByRole("button", { name: "Reply in thread" })).toHaveLength(4);
  const user = userEvent.setup();
  await user.click(page.getByRole("button", { name: "Mute channel notifications" }));
  expect(onMutedChange).toHaveBeenCalledWith(true);
  await user.type(page.getByLabelText("Message"), "A shared conversation");
  await user.click(page.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith("A shared conversation", expect.any(String), undefined);
});

test.each([true, false])(
  "empty channel keeps its identity and the correct entry action (joined=%s)",
  (joined) => {
    render(
      <AppToastProvider>
        <ChannelConversation
          conversation={{ ...history, messages: [], senderMemberId: joined ? "alice-member" : "" }}
          onSend={async () => {}}
          onJoin={async () => {}}
          onMutedChange={async () => {}}
        />
      </AppToastProvider>,
    );
    const page = within(document.body);
    const empty = within(page.getByLabelText("Message history"));
    expect(empty.getByRole("heading", { name: "#engineering" })).toBeTruthy();
    expect(empty.queryByText(/private conversation/)).toBeNull();
    if (joined) {
      expect(
        empty.getByText(
          "This is the start of the channel. Send the first message to your Workspace.",
        ),
      ).toBeTruthy();
      expect(page.getByRole("textbox", { name: "Message" })).toBeTruthy();
      expect(page.queryByRole("button", { name: "Join channel" })).toBeNull();
    } else {
      expect(empty.getByText("Messages shared in this channel will appear here.")).toBeTruthy();
      expect(page.queryByRole("textbox")).toBeNull();
      expect(page.getAllByRole("button", { name: "Join channel" })).toHaveLength(1);
    }
  },
);

test("a non-joined Workspace member can read but must join before composing", async () => {
  const onJoin = mock(async () => {});
  render(
    <AppToastProvider>
      <ChannelConversation
        conversation={{ ...history, senderMemberId: "" }}
        onSend={async () => {}}
        onJoin={onJoin}
        onMutedChange={async () => {}}
      />
    </AppToastProvider>,
  );
  const page = within(document.body);
  expect(page.getByText("Hello Bob")).toBeTruthy();
  expect(page.queryByRole("textbox")).toBeNull();
  expect(document.querySelector('[data-message="own"]')).toBeNull();
  await userEvent.setup().click(page.getByRole("button", { name: "Join channel" }));
  expect(onJoin).toHaveBeenCalledTimes(1);
});

test("channel header keeps its title above Chat and counted Tasks tabs", async () => {
  const onShowTasks = mock(() => {});
  render(
    <AppToastProvider>
      <ChannelConversation
        conversation={history}
        tasks={[
          {
            messageId: "task-1",
            conversationId: history.conversationId,
            number: 1,
            title: "First task",
            status: "todo",
            revision: 1,
            owner: null,
          },
          {
            messageId: "task-2",
            conversationId: history.conversationId,
            number: 2,
            title: "Second task",
            status: "done",
            revision: 1,
            owner: null,
          },
        ]}
        onSend={async () => {}}
        onJoin={async () => {}}
        onMutedChange={async () => {}}
        onShowTasks={onShowTasks}
      />
    </AppToastProvider>,
  );
  const page = within(document.body);
  expect(page.getByRole("heading", { name: "#engineering" })).toBeTruthy();
  expect(page.getByRole("button", { name: "Chat" }).getAttribute("aria-current")).toBe("page");
  await userEvent.setup().click(page.getByRole("button", { name: "Tasks 2" }));
  expect(onShowTasks).toHaveBeenCalledTimes(1);
});

test("channel threads keep replies out of the main flow and send to the selected root", async () => {
  const user = userEvent.setup();
  const onSend = mock(async () => {});
  const onThreadFollowedChange = mock(async () => {});
  const root = {
    ...history.messages[0]!,
    id: "12345678-0000-4000-8000-000000000001",
  };
  render(
    <AppToastProvider>
      <ChannelConversation
        conversation={{
          ...history,
          threadReadThrough: { [root.id]: 0 },
          followedThreadRootIds: [root.id],
          messages: [
            root,
            {
              ...history.messages[1]!,
              id: "thread-reply",
              threadRootId: root.id,
              body: "Only in the channel thread",
            },
          ],
        }}
        onSend={onSend}
        onJoin={async () => {}}
        onMutedChange={async () => {}}
        onReadThread={async () => {}}
        onThreadFollowedChange={onThreadFollowedChange}
      />
    </AppToastProvider>,
  );
  const page = within(document.body);
  expect(page.getByLabelText("Message history").querySelectorAll("[data-message]")).toHaveLength(1);
  await user.click(page.getByRole("button", { name: /1 reply/ }));
  const discussion = within(page.getByRole("region", { name: "Thread" }));
  expect(discussion.getByText("Only in the channel thread")).toBeTruthy();
  expect(page.getByRole("button", { name: /@bob Only in the channel thread/ })).toBeTruthy();
  await user.click(discussion.getByRole("button", { name: "Unfollow thread" }));
  expect(onThreadFollowedChange).toHaveBeenCalledWith(root.id, false);
  await user.type(discussion.getByLabelText("Message"), "Channel thread response");
  await user.click(discussion.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith(
    "Channel thread response",
    expect.any(String),
    undefined,
    root.id,
  );
});
