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
        onRefresh={async () => {}}
      />
    </AppToastProvider>,
  );
  const page = within(document.body);
  expect(page.getByRole("heading", { name: "#engineering" })).toBeTruthy();
  const own = document.querySelector('[data-message="own"]')!;
  const other = document.querySelector('[data-message="other"]')!;
  expect(own.textContent).toContain("You");
  expect(other.textContent).toContain("@bob");
  expect(other.textContent).not.toContain("You");
  expect(page.queryByRole("button", { name: "Reply in thread" })).toBeNull();
  const user = userEvent.setup();
  await user.click(page.getByRole("button", { name: "Mute channel notifications" }));
  expect(onMutedChange).toHaveBeenCalledWith(true);
  await user.type(page.getByLabelText("Message"), "A shared conversation");
  await user.click(page.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith("A shared conversation", expect.any(String), undefined);
});

test("a non-joined Workspace member can read but must join before composing", async () => {
  const onJoin = mock(async () => {});
  render(
    <AppToastProvider>
      <ChannelConversation
        conversation={{ ...history, senderMemberId: "" }}
        onSend={async () => {}}
        onJoin={onJoin}
        onMutedChange={async () => {}}
        onRefresh={async () => {}}
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
