import "../dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { Match, RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";

const agents = [
  {
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: "first",
    displayName: "First Agent",
    createdAt: new Date("2026-08-29T00:00:00Z"),
    runtimeConfig: { provider: "pi" as const, model: "", reasoning: "" },
  },
  {
    id: "agent-2",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: "second",
    displayName: "Second Agent",
    createdAt: new Date("2026-08-29T00:00:00Z"),
    runtimeConfig: { provider: "pi" as const, model: "", reasoning: "" },
  },
];
const listAgents = mock(async () => agents);
const loadDirectConversation = mock(async ({ data }: { data: { agentId: string } }) => ({
  conversationId: `conversation-${data.agentId}`,
  senderMemberId: "member-1",
  agent: agents.find((agent) => agent.id === data.agentId) ?? agents[0],
  messages: [],
}));

mock.module("@/features/agents/agents.functions", () => ({
  createAgent: mock(async () => agents[0]),
  listAgents,
}));
mock.module("@/features/conversations/conversations.functions", () => ({
  loadDirectConversation,
  sendDirectConversationMessage: mock(async () => {}),
}));
mock.module("@/server/auth/current-user", () => ({
  peekCurrentUser: mock(async () => undefined),
  requireCurrentUser: mock(async () => ({
    id: "user-1",
    name: "Route Tester",
    email: "route@example.com",
    authingSub: "authing-route-tester",
    username: "route-tester",
  })),
}));

const { getRouter } = await import("@/router");

afterEach(() => {
  cleanup();
  listAgents.mockClear();
  loadDirectConversation.mockClear();
});

async function renderRoute(path: string) {
  const router = getRouter();
  router.update({
    defaultPreload: false,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(() => router.load());
  render(
    <RouterContextProvider router={router}>
      <Match routeId="/_app" />
    </RouterContextProvider>,
  );
  return { router, page: within(document.body) };
}

test("the messages index selects the first Agent", async () => {
  const { router, page } = await renderRoute("/messages");
  await waitFor(() => expect(router.state.location.pathname).toBe("/messages/agent-1"));
  expect(page.getByRole("heading", { name: "First Agent" })).toBeTruthy();
  expect(loadDirectConversation).toHaveBeenCalledWith({ data: { agentId: "agent-1" } });
});

test("a direct URL renders the second Agent through the Outlet and highlights it", async () => {
  const { router, page } = await renderRoute("/messages/agent-2");
  expect(router.state.location.pathname).toBe("/messages/agent-2");
  await waitFor(() => expect(page.getByRole("heading", { name: "Second Agent" })).toBeTruthy());
  expect(page.getByRole("link", { name: /Second Agent/ }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(loadDirectConversation).toHaveBeenCalledWith({ data: { agentId: "agent-2" } });
});
