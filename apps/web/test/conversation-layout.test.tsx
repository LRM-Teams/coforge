import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";

import {
  ConversationLayout,
  EmptyConversation,
  useConversationAgentStatus,
} from "@/features/conversations/conversation-layout";
import { getRouter } from "@/router";

afterEach(cleanup);

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
  expect(page.getByLabelText("Release Helper, Online")).toBeTruthy();
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
