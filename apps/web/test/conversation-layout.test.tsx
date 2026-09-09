import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { AppShell } from "@/components/app-shell";
import { AppToastProvider } from "@/components/ui/toast";
import {
  BackToAgents,
  ConversationLayout,
  EmptyConversation,
  useConversationActivity,
  useConversationAgentStatus,
} from "@/features/conversations/conversation-layout";
import { getRouter } from "@/router";

afterEach(cleanup);

test("the conversation list owns the mobile menu and keeps its position when returning", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={{ name: "Test User", email: "test@example.com" }}>
          <ConversationLayout agents={[agent]} selectedAgentId={agent.id}>
            <header>
              <BackToAgents />
              <h1>Selected conversation</h1>
            </header>
          </ConversationLayout>
        </AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );
  const page = within(document.body);
  const list = page.getByRole("navigation", { name: "Agent conversations" });
  fireEvent.click(page.getByRole("button", { name: "Messages" }));
  const scroller = within(list).getByRole("list", { name: "Channels" }).parentElement!;
  scroller.scrollTop = 147;
  fireEvent.click(within(list).getByRole("link", { name: /Release Helper/ }));
  fireEvent.click(page.getByRole("button", { name: "Messages" }));
  expect(within(list).getByRole("list", { name: "Channels" }).parentElement).toBe(scroller);
  expect(scroller.scrollTop).toBe(147);
  const menu = within(list).getByRole("button", { name: "Show sidebar" });
  fireEvent.click(menu);
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  expect(page.getByRole("heading", { name: "Selected conversation" })).toBeTruthy();
  for (const header of document.querySelectorAll("header")) {
    expect(header.closest("main")).not.toBeNull();
  }
});

const agent = {
  id: "agent-1",
  name: "release-helper",
  displayName: "Release Helper",
  createdAt: "2026-08-20T12:00:00.000Z",
  runtimeConfig: { runtime: "codex" as const, model: "gpt-5" },
  status: { value: "active" as const, expiresAt: Date.now() + 60_000 },
};

function renderLayout(agents = [agent], selectedAgentId = agent.id) {
  render(
    <RouterContextProvider router={getRouter()}>
      <ConversationLayout agents={agents} selectedAgentId={selectedAgentId}>
        <p>Conversation</p>
      </ConversationLayout>
    </RouterContextProvider>,
  );
  return within(document.body);
}

test("shows real Agents as typed conversation links and highlights the selection", () => {
  const page = renderLayout();
  expect(page.getByRole("heading", { name: "Messages" })).toBeTruthy();
  expect(page.getByRole("navigation", { name: "Agent conversations" })).toBeTruthy();
  expect(page.getByText("Release Helper")).toBeTruthy();
  expect(page.getByText("@release-helper")).toBeTruthy();
  const link = page.getByRole("link", { name: /Release Helper/ });
  expect(link.getAttribute("href")).toBe("/en/messages/agent-1");
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(page.queryByText("Codex / gpt-5")).toBeNull();
  expect(
    page.getByRole("button", {
      name: "Release Helper, Online, Recent activity",
    }),
  ).toBeTruthy();
  expect(page.queryByText(/unread/i)).toBeNull();
});

test("shows the chat empty state without an Agents action", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <ConversationLayout agents={[]}>
        <EmptyConversation />
      </ConversationLayout>
    </RouterContextProvider>,
  );
  const page = within(document.body);
  expect(page.getByText("No Agents available for private messages")).toBeTruthy();
  expect(page.queryByRole("link")).toBeNull();
});

test("keeps an authorized conversation when its Agent status is temporarily absent", () => {
  function SelectedConversation() {
    const status = useConversationAgentStatus();
    return <p>{status ?? "presence unknown"}</p>;
  }
  render(
    <RouterContextProvider router={getRouter()}>
      <ConversationLayout agents={[]} selectedAgentId="agent-1">
        <SelectedConversation />
      </ConversationLayout>
    </RouterContextProvider>,
  );
  expect(within(document.body).getByText("presence unknown")).toBeTruthy();
});

test("saved timezone and usable activity reach both sidebar and conversation despite history failure", async () => {
  function SelectedConversation() {
    const view = useConversationActivity(agent.id);
    return <p>{`${view.timeZone}/${view.loading}/${view.error}/${view.activity.length}`}</p>;
  }
  render(
    <RouterContextProvider router={getRouter()}>
      <ConversationLayout
        agents={[agent]}
        selectedAgentId={agent.id}
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
      </ConversationLayout>
    </RouterContextProvider>,
  );
  const page = within(document.body);
  expect(page.getByText("Asia/Shanghai/false/false/1")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: /Release Helper/ }));
  const popup = await page.findByRole("dialog");
  expect(popup.querySelector("time")?.textContent).toBe("15:18:30");
});
