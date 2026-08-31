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
  getAgentDetail: mock(async () => {
    const failure = {
      id: "activity-1",
      computerId: "computer-12345678",
      launchId: "launch-1",
      clientSeq: 2,
      activity: "launch_failed",
      level: "error",
      message: "Agent runtime could not be started.",
      occurredAt: new Date("2026-08-29T00:00:01Z"),
      createdAt: new Date("2026-08-29T00:00:02Z"),
    };
    const starting = {
      ...failure,
      id: "activity-2",
      clientSeq: 1,
      activity: "starting",
      level: "info",
      message: "Agent runtime is starting.",
      occurredAt: new Date("2026-08-29T00:00:00Z"),
      createdAt: new Date("2026-08-29T00:00:01Z"),
    };
    return {
      ...agents[0],
      owner: { id: "user-1", username: "route-tester" },
      computer: { id: failure.computerId, label: "computer…5678" },
      latestError: failure,
      activity: [failure, starting],
    };
  }),
  listAgents,
}));
mock.module("@/features/conversations/conversations.functions", () => ({
  loadDirectConversation,
  sendDirectConversationMessage: mock(async () => {}),
}));
mock.module("@/features/settings/settings.functions", () => ({
  getUserPreferences: mock(async () => ({ timeZone: null })),
  saveUserTimeZone: mock(async () => ({ timeZone: null })),
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

test("an Agent profile shows its Computer, runtime configuration, and latest failure", async () => {
  const { page } = await renderRoute("/agents/agent-1?tab=profile");
  expect(page.getByRole("heading", { name: "First Agent" })).toBeTruthy();
  expect(page.getByText("computer…5678")).toBeTruthy();
  expect(page.getByText(/"provider": "pi"/)).toBeTruthy();
  expect(page.getByRole("alert").textContent).toContain("Agent runtime could not be started.");
});

test("an Agent Activity tab shows only time, action, and message", async () => {
  const { page } = await renderRoute("/agents/agent-1?tab=activity");
  expect(page.getByText("Failed")).toBeTruthy();
  expect(page.getByText("Starting")).toBeTruthy();
  expect(page.getAllByText("Agent runtime could not be started.")).toHaveLength(1);
  expect(page.queryByText("Agent runtime is starting.")).toBeNull();
  expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-29T00:00:01.000Z");
  expect(page.queryByText("launch_failed")).toBeNull();
  expect(page.queryByText(/launch-1/)).toBeNull();
  expect(page.queryByText("error")).toBeNull();
});
