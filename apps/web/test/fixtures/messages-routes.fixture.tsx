import "../dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { Match, RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { AppToastProvider } from "@/components/ui/toast";
import { encodeAgentActivity } from "@coforge/protocol";
import type { ActivityEntry } from "@/features/agents/agent-activity";

let detailOnline = false;
let publishActivity = (_publication: { channel: string; data: Uint8Array }) => {};
let connectActivity = () => {};
let detailReadCount = 0;
let historyBlock: Promise<void> | undefined;
let extraHistory: ActivityEntry[] = [];
const agents = [
  {
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: "first",
    displayName: "First Agent",
    createdAt: new Date("2026-08-29T00:00:00Z"),
    runtimeConfig: { provider: "pi" as const, model: "", reasoning: "" },
    status: { value: "inactive" as const, expiresAt: null },
  },
  {
    id: "agent-2",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: "second",
    displayName: "Second Agent",
    createdAt: new Date("2026-08-29T00:00:00Z"),
    runtimeConfig: { provider: "pi" as const, model: "", reasoning: "" },
    status: { value: "inactive" as const, expiresAt: null },
  },
];
const listAgents = mock(async () => agents);
const loadDirectConversation = mock(async ({ data }: { data: { agentId: string } }) => ({
  conversationId: `conversation-${data.agentId}`,
  senderMemberId: "member-1",
  agent: agents.find((agent) => agent.id === data.agentId) ?? agents[0],
  messages: [],
}));
const getUserProfile = mock(async () => ({
  name: "Route Tester",
  email: "route@example.com",
  username: "route-tester",
  description: "",
  avatarUrl: null,
}));
const loadWorkspaceSwitcher = mock(async () => ({
  workspaces: [{ id: "workspace-1", slug: "route-tester", name: "Route Tester's Workspace" }],
  current: { id: "workspace-1", slug: "route-tester", name: "Route Tester's Workspace" },
}));

mock.module("@/features/agents/agents.functions", () => ({
  createAgent: mock(async () => agents[0]),
  updateAgent: mock(async () => ({ restart: "not-required" })),
  deleteAgentRuntimeCredential: mock(async () => ({ deleted: true })),
  saveAgentRuntimeCredential: mock(async () => ({ saved: true })),
  retryAgentStart: mock(async () => {}),
  getAgentStatusConnectionToken: mock(async () => "test-agent-status-token"),
  getAgentActivityConnectionToken: mock(async () => "test-agent-activity-token"),
  getAgentDetail: mock(async () => {
    detailReadCount++;
    if (historyBlock) await historyBlock;
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
      status: detailOnline ? { value: "active", expiresAt: Date.now() + 90_000 } : agents[0].status,
      owner: { id: "user-1", username: "route-tester" },
      computer: { id: failure.computerId, label: "computer…5678" },
      latestError: failure,
      activity: [...extraHistory, failure, starting],
    };
  }),
  listAgents,
}));
mock.module("@/features/conversations/conversations.functions", () => ({
  loadDirectConversation,
  markDirectThreadRead: mock(async () => {}),
  sendDirectConversationMessage: mock(async () => {}),
}));
mock.module("@/features/conversations/channels.functions", () => ({
  listPublicChannels: mock(async () => [{ id: "channel-1", name: "general", joined: true }]),
  loadPublicChannel: mock(async () => ({
    conversationId: "channel-1",
    name: "general",
    senderMemberId: "member-1",
    muted: false,
    messages: [],
  })),
  createPublicChannel: mock(async () => ({ id: "channel-1" })),
  joinPublicChannel: mock(async () => {}),
  setPublicChannelMuted: mock(async () => ({ muted: true })),
  sendPublicChannelMessage: mock(async () => {}),
}));
mock.module("@/features/settings/settings.functions", () => ({
  getUserPreferences: mock(async () => ({ timeZone: null })),
  saveUserTimeZone: mock(async () => ({ timeZone: null })),
}));
mock.module("@/features/notifications/notifications.functions", () => ({
  getBrowserNotificationSettings: mock(async () => ({ enabled: false, publicKey: null })),
  subscribeBrowserPush: mock(async () => {}),
  unsubscribeBrowserPush: mock(async () => {}),
  saveBrowserNotificationPreference: mock(async () => ({ enabled: false })),
  sendTestBrowserNotification: mock(async () => ({ sent: 1, failed: 0, removed: 0 })),
}));
mock.module("@/features/profiles/profile.functions", () => ({
  getUserProfile,
  saveUserProfile: mock(async () => ({ name: "Route Tester", description: "" })),
}));
mock.module("@/server/auth/current-user", () => ({
  peekCurrentUser: mock(async () => undefined),
}));
mock.module("@/features/workspaces/workspaces.functions", () => ({
  loadWorkspaceSwitcher,
  selectWorkspace: mock(async () => {}),
  createWorkspace: mock(async () => {}),
}));
mock.module("centrifuge", () => ({
  Centrifuge: class {
    on() {
      return this;
    }
    connect() {}
    disconnect() {}
  },
}));
mock.module("centrifuge/build/protobuf", () => ({
  Centrifuge: class {
    on(event: string, listener: typeof publishActivity) {
      if (event === "publication") publishActivity = listener;
      if (event === "connected")
        connectActivity = () => listener({ channel: "", data: new Uint8Array() });
      return this;
    }
    connect() {}
    disconnect() {}
  },
}));

const { getRouter } = await import("@/router");

afterEach(() => {
  cleanup();
  detailOnline = false;
  publishActivity = () => {};
  connectActivity = () => {};
  detailReadCount = 0;
  historyBlock = undefined;
  extraHistory = [];
  listAgents.mockClear();
  loadDirectConversation.mockClear();
  getUserProfile.mockClear();
  loadWorkspaceSwitcher.mockClear();
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
      <AppToastProvider>
        <Match routeId="/_app" />
      </AppToastProvider>
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

test("channel URL uses the shared messages layout and selects the channel", async () => {
  const { page } = await renderRoute("/messages/channels/channel-1");
  expect(page.getByRole("heading", { name: "#general" })).toBeTruthy();
  expect(page.getByRole("link", { name: /general/ }).getAttribute("aria-current")).toBe("page");
  expect(page.getByRole("button", { name: "Create channel" })).toBeTruthy();
  expect(page.getByRole("textbox", { name: "Message" })).toBeTruthy();
});

test("reuses parent application data across sidebar destinations", async () => {
  const { router } = await renderRoute("/messages/agent-1");
  expect(getUserProfile).toHaveBeenCalledTimes(1);
  expect(loadWorkspaceSwitcher).toHaveBeenCalledTimes(1);

  await act(() =>
    router.navigate({
      to: "/agents/$agentId",
      params: { agentId: "agent-1" },
      search: { tab: "profile" },
    }),
  );

  expect(getUserProfile).toHaveBeenCalledTimes(1);
  expect(loadWorkspaceSwitcher).toHaveBeenCalledTimes(1);
});

test("an Agent profile shows its Computer, runtime configuration, and latest failure", async () => {
  const { page } = await renderRoute("/agents/agent-1?tab=profile");
  expect(page.getByRole("heading", { name: "First Agent" })).toBeTruthy();
  expect(page.getByRole("img", { name: "First Agent, Offline" })).toBeTruthy();
  expect(page.getByText("Offline")).toBeTruthy();
  expect(page.getByText("computer…5678")).toBeTruthy();
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

test("profile shows Online and clears an old failure on live recovery without navigation", async () => {
  detailOnline = true;
  const { page } = await renderRoute("/agents/agent-1?tab=profile");
  expect(page.getByRole("img", { name: "First Agent, Online" })).toBeTruthy();
  expect(page.getByText("Online")).toBeTruthy();
  expect(page.getByRole("alert")).toBeTruthy();
  await act(async () =>
    publishActivity({
      channel: "activity:workspace-1",
      data: encodeAgentActivity({
        protocolMajor: 1,
        requestId: "request-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        launchId: "launch-2",
        clientSeq: 1,
        activity: "starting",
        level: "info",
        message: "Starting",
        occurredAt: "2026-08-29T00:00:03Z",
      }),
    }),
  );
  expect(page.queryByRole("alert")).toBeNull();
  expect(page.getByText("Online")).toBeTruthy();
});

test("Activity appends matching live observations once and renders turn completion as Idle", async () => {
  const { page } = await renderRoute("/agents/agent-1?tab=activity");
  const event = {
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    launchId: "launch-2",
    clientSeq: 1,
    activity: "turn_completed",
    level: "info" as const,
    message: "Agent turn completed.",
    occurredAt: "2026-08-29T00:00:03Z",
  };
  await act(async () => {
    publishActivity({
      channel: "activity:workspace-1",
      data: encodeAgentActivity({ ...event, agentId: "agent-2" }),
    });
  });
  expect(page.queryByText("Idle")).toBeNull();
  await act(async () => {
    const publication = { channel: "activity:workspace-1", data: encodeAgentActivity(event) };
    publishActivity(publication);
    publishActivity(publication);
  });
  expect(page.getAllByText("Idle")).toHaveLength(1);
  expect(page.queryByText("Run completed")).toBeNull();
  expect(page.getByText("Agent runtime could not be started.")).toBeTruthy();
});

test("reconnect hydrates missed history without losing activity arriving during the read", async () => {
  const { page } = await renderRoute("/agents/agent-1?tab=activity");
  const beforeConnect = detailReadCount;
  await act(async () => connectActivity());
  await waitFor(() => expect(detailReadCount).toBe(beforeConnect + 1));
  const gate = Promise.withResolvers<void>();
  historyBlock = gate.promise;
  try {
    await act(async () => connectActivity());
    await waitFor(() => expect(detailReadCount).toBe(beforeConnect + 2));
    await act(async () =>
      publishActivity({
        channel: "activity:workspace-1",
        data: encodeAgentActivity({
          protocolMajor: 1,
          requestId: "live",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          launchId: "launch-2",
          clientSeq: 2,
          activity: "using_tool",
          level: "info",
          message: "Live during reload",
          occurredAt: "2026-08-29T00:00:04Z",
        }),
      }),
    );
    expect(page.getByText("Live during reload")).toBeTruthy();
    extraHistory = [
      {
        id: "persisted-missed",
        launchId: "launch-2",
        clientSeq: 1,
        activity: "using_tool",
        level: "info",
        message: "Recovered history",
        occurredAt: new Date("2026-08-29T00:00:03Z"),
        createdAt: new Date("2026-08-29T00:00:03Z"),
      },
    ];
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(page.getByText("Recovered history")).toBeTruthy());
    expect(page.getAllByText("Live during reload")).toHaveLength(1);
  } finally {
    gate.resolve();
  }
});
