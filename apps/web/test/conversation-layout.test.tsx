import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { SidebarConversations } from "@/components/layout/sidebar/sidebar-conversations";
import {
  ConversationRealtimeProvider,
  EmptyConversation,
  useConversationActivity,
  useConversationAgentStatus,
} from "@/features/conversations/conversation-layout";

afterEach(cleanup);

const agent = {
  id: "agent-1",
  name: "release-helper",
  displayName: "Release Helper",
  createdAt: "2026-08-20T12:00:00.000Z",
  runtimeConfig: { runtime: "codex" as const, model: "gpt-5" },
  status: { value: "active" as const, expiresAt: Date.now() + 60_000 },
};

const channels = [
  { id: "channel-1", name: "general", joined: true },
  { id: "channel-2", name: "roadmap", joined: false },
];

test("lists Channels (joined first) and Direct messages as typed links, highlighting the current one", () => {
  render(
    <SidebarConversations
      channels={channels}
      agents={[agent]}
      selectedChannelId="channel-1"
      onCreateChannel={() => {}}
    />,
  );
  const page = within(document.body);

  const channelList = page.getByRole("list", { name: "Channels" });
  const channelLinks = within(channelList).getAllByRole("link");
  expect(channelLinks.map((link) => link.textContent)).toEqual(["#general", "#roadmap"]);
  expect(channelLinks[0].getAttribute("aria-current")).toBe("page");
  expect(channelLinks[1].getAttribute("aria-current")).toBeNull();
  // Not-joined channels read as de-emphasized rather than hidden. (The outer
  // span is NavItemBase's own label wrapper; ours nests inside it.)
  expect(channelLinks[1].querySelector("span > span")?.className).toContain("text-tertiary");
  expect(channelLinks[0].getAttribute("href")).toBe("/en/messages/channels/channel-1");

  const dmList = page.getByRole("list", { name: "Direct messages" });
  const dmLink = within(dmList).getByRole("link", { name: /Release Helper/ });
  expect(dmLink.getAttribute("href")).toBe("/en/messages/agent-1");
  expect(dmLink.getAttribute("aria-current")).toBeNull();
});

test("creating a channel is available from the sidebar's section header", () => {
  let clicked = false;
  render(
    <SidebarConversations
      channels={channels}
      agents={[]}
      onCreateChannel={() => {
        clicked = true;
      }}
    />,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: "Create channel" }));
  expect(clicked).toBe(true);
});

test("omits the create-channel control when no handler is given", () => {
  render(<SidebarConversations channels={channels} agents={[]} />);
  expect(within(document.body).queryByRole("button", { name: "Create channel" })).toBeNull();
});

test("shows the chat empty state", () => {
  render(<EmptyConversation />);
  const page = within(document.body);
  expect(page.getByText("No Agents available for private messages")).toBeTruthy();
  expect(page.queryByRole("link")).toBeNull();
});

test("keeps an authorized conversation when its Agent status is temporarily absent", () => {
  function SelectedConversation() {
    const status = useConversationAgentStatus("agent-1");
    return <p>{status ?? "presence unknown"}</p>;
  }
  render(
    <ConversationRealtimeProvider agents={[]}>
      <SelectedConversation />
    </ConversationRealtimeProvider>,
  );
  expect(within(document.body).getByText("presence unknown")).toBeTruthy();
});

test("saved timezone and usable activity reach the conversation despite history failure", () => {
  function SelectedConversation() {
    const view = useConversationActivity(agent.id);
    return <p>{`${view.timeZone}/${view.loading}/${view.error}/${view.activity.length}`}</p>;
  }
  render(
    <ConversationRealtimeProvider
      agents={[agent]}
      timeZone="Asia/Shanghai"
      activityView={{
        loading: false,
        error: true,
        activity: {
          [agent.id]: [
            {
              launchId: "launch",
              clientSeq: 1,
              detailKind: "running_command",
              level: "info",
              detail: "",
              observedAtMs: Date.parse("2026-09-07T07:18:30Z"),
            },
          ],
        },
      }}
    >
      <SelectedConversation />
    </ConversationRealtimeProvider>,
  );
  // activityForAgent (workspace-activity-realtime.ts) only surfaces `error`
  // when there's no cached activity to show in its place — here there is.
  expect(within(document.body).getByText("Asia/Shanghai/false/false/1")).toBeTruthy();
});
