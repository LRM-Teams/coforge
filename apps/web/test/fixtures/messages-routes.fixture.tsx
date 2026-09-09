import "../dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { Match, RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppToastProvider } from "@/components/ui/toast";
import { encodeAgentActivity } from "@coforge/protocol";
import type { DirectConversationView } from "@/features/conversations/direct-conversation";
type HistoryActivity = {
  id: string;
  launchId: string;
  clientSeq: number;
  detailKind: string;
  level: "info" | "warning" | "error";
  detail: string;
  observedAtMs: number;
};

let detailOnline = false;
let publishActivity = (_publication: { channel: string; data: Uint8Array }) => {};
let connectActivity = () => {};
let detailReadCount = 0;
let historyBlock: Promise<void> | undefined;
let extraHistory: HistoryActivity[] = [];
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
const loadDirectConversation = mock(
  async ({ data }: { data: { agentId: string } }): Promise<DirectConversationView> => ({
    conversationId: `conversation-${data.agentId}`,
    senderMemberId: "member-1",
    agent: agents.find((agent) => agent.id === data.agentId) ?? agents[0],
    messages: [],
  }),
);
const loadDirectConversationUpdates = mock(
  async ({
    data,
  }: {
    data: { agentId: string; afterSequence: number };
  }): Promise<DirectConversationView["messages"]> => {
    void data;
    return [];
  },
);
const loadOwnConversationMessages = mock(
  async ({ data }: { data: { conversationId: string } }) => ({
    messages: [
      {
        id: `own-${data.conversationId}`,
        sequence: 1,
        body: `Own message in ${data.conversationId}`,
        createdAt: new Date("2026-08-29T00:00:00Z"),
      },
    ],
    hasOlder: false,
  }),
);
const loadConversationAround = mock(
  async ({ data }: { data: { conversationId: string; messageId: string } }) => ({
    conversationId: data.conversationId,
    messages: [
      {
        id: data.messageId,
        sequence: 1,
        senderMemberId: "member-1",
        senderKind: "user" as const,
        senderName: "@route-tester",
        body: `Own message in ${data.conversationId}`,
        createdAt: new Date("2026-08-29T00:00:00Z"),
      },
    ],
    hasOlder: false,
    hasNewer: false,
  }),
);
const sendDirectConversationMessage = mock(
  async ({
    data,
  }: {
    data: { body: string; threadRootId?: string };
  }): Promise<DirectConversationView["messages"][number]> => ({
    id: "sent-direct-message",
    sequence: 1,
    threadRootId: data.threadRootId,
    senderKind: "user" as const,
    senderMemberId: "member-1",
    senderName: "@route-tester",
    body: data.body,
    createdAt: new Date("2026-08-29T00:00:03Z"),
  }),
);
const loadPublicChannelUpdates = mock(async () => []);
const loadPublicChannel = mock(async () => ({
  conversationId: "channel-1",
  name: "general",
  senderMemberId: "member-1",
  muted: false,
  messages: [],
}));
const sendPublicChannelMessage = mock(async ({ data }: { data: { body: string } }) => ({
  id: "sent-channel-message",
  sequence: 1,
  senderMemberId: "member-1",
  senderKind: "user" as const,
  senderName: "@route-tester",
  body: data.body,
  createdAt: new Date("2026-08-29T00:00:04Z"),
}));
const getUserProfile = mock(async () => ({
  name: "Route Tester",
  email: "route@example.com",
  username: "route-tester",
  description: "",
  avatarUrl: null,
}));
const loadWorkspaceSwitcher = mock(async () => ({
  workspaces: [
    {
      id: "workspace-1",
      slug: "route-tester",
      name: "Route Tester's Workspace",
    },
  ],
  current: {
    id: "workspace-1",
    slug: "route-tester",
    name: "Route Tester's Workspace",
  },
}));

mock.module("@/features/agents/agents.functions", () => ({
  createAgent: mock(async () => agents[0]),
  updateAgent: mock(async () => ({ restart: "not-required" })),
  deleteAgentRuntimeCredential: mock(async () => ({ deleted: true })),
  saveAgentRuntimeCredential: mock(async () => ({ saved: true })),
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
      detailKind: "launch_failed",
      level: "error",
      detail: "Agent runtime could not be started.",
      observedAtMs: Date.parse("2026-08-29T00:00:01Z"),
    };
    const starting = {
      ...failure,
      id: "activity-2",
      clientSeq: 1,
      detailKind: "starting",
      level: "info",
      detail: "Agent runtime is starting.",
      observedAtMs: Date.parse("2026-08-29T00:00:00Z"),
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
  loadConversationAround,
  loadDirectConversationUpdates,
  loadOwnConversationMessages,
  markDirectThreadRead: mock(async () => {}),
  sendDirectConversationMessage,
}));
mock.module("@/features/conversations/channels.functions", () => ({
  listPublicChannels: mock(async () => [{ id: "channel-1", name: "general", joined: true }]),
  loadPublicChannel,
  loadPublicChannelUpdates,
  createPublicChannel: mock(async () => ({ id: "channel-1" })),
  joinPublicChannel: mock(async () => {}),
  markPublicChannelThreadRead: mock(async () => {}),
  setPublicChannelMuted: mock(async () => ({ muted: true })),
  setPublicChannelThreadFollowed: mock(async () => ({ followed: true })),
  sendPublicChannelMessage,
}));
mock.module("@/features/settings/settings.functions", () => ({
  getUserPreferences: mock(async () => ({ timeZone: null })),
  saveUserTimeZone: mock(async () => ({ timeZone: null })),
}));
mock.module("@/features/computers/computers.functions", () => ({
  listComputers: mock(async () => []),
  getComputerRuntimeCatalog: mock(async () => []),
  restartComputer: mock(async () => {}),
  readComputerRestartStatus: mock(async () => null),
  scanUsage: mock(async () => {}),
  readUsage: mock(async () => null),
  setRuntimeVisibility: mock(async () => {}),
  updateComputerDisplayName: mock(async () => {}),
}));
mock.module("@/features/notifications/notifications.functions", () => ({
  getBrowserNotificationSettings: mock(async () => ({
    enabled: false,
    publicKey: null,
  })),
  subscribeBrowserPush: mock(async () => {}),
  unsubscribeBrowserPush: mock(async () => {}),
  saveBrowserNotificationPreference: mock(async () => ({ enabled: false })),
  sendTestBrowserNotification: mock(async () => ({
    sent: 1,
    failed: 0,
    removed: 0,
  })),
}));
mock.module("@/features/profiles/profile.functions", () => ({
  getUserProfile,
  saveUserProfile: mock(async () => ({
    name: "Route Tester",
    description: "",
  })),
}));
mock.module("@/server/auth/current-user", () => ({
  peekCurrentUser: mock(async () => undefined),
}));
mock.module("@/features/workspaces/workspaces.functions", () => ({
  loadWorkspaceSwitcher,
  listWorkspaceMembers: mock(async () => ({ people: [], agents: [] })),
  selectWorkspace: mock(async () => {}),
  createWorkspace: mock(async () => {}),
}));
mock.module("@/features/realtime/realtime.functions", () => ({
  getBrowserRealtimeConnectionToken: mock(async () => "test-connection-token"),
  getConversationRealtimeToken: mock(async () => "test-subscription-token"),
}));
mock.module("centrifuge", () => ({
  Centrifuge: class {
    on() {
      return this;
    }
    off() {
      return this;
    }
    newSubscription() {
      return {
        on() {
          return this;
        },
        subscribe() {},
        unsubscribe() {},
      };
    }
    removeSubscription() {}
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

test("settings first load uses placeholders and refresh preserves the active edit", async () => {
  const { router, page } = await renderRoute("/agents");
  const route = router.routesById["/_app/settings"];
  const loader = route.options.loader;
  const first = Promise.withResolvers<{ timeZone: null }>();
  route.options.loader = () => first.promise;
  let navigation: Promise<void> | undefined;
  try {
    await act(async () => {
      navigation = router.navigate({ to: "/settings" });
    });
    await waitFor(() => expect(page.getByRole("status").textContent).toBe("Loading settings…"));
    expect(page.queryByRole("button", { name: "Edit" })).toBeNull();
    await act(async () => {
      first.resolve({ timeZone: null });
      await navigation;
    });
    await userEvent.setup().click(page.getByRole("button", { name: "Edit" }));
    const draft = page.getByRole("textbox", { name: "Description" });
    await userEvent.setup().type(draft, "Unsaved settings draft");
    const refresh = Promise.withResolvers<{ timeZone: null }>();
    route.options.loader = () => refresh.promise;
    let refreshed: Promise<void> | undefined;
    try {
      await act(async () => {
        refreshed = router.invalidate();
      });
      expect(page.getByRole("textbox", { name: "Description" })).toBe(draft);
      expect(page.queryByRole("status")).toBeNull();
    } finally {
      await act(async () => {
        refresh.resolve({ timeZone: null });
        await refreshed;
      });
    }
    expect(page.getByRole("textbox", { name: "Description" })).toBe(draft);
    expect(page.getByDisplayValue("Unsaved settings draft")).toBe(draft);
    expect(draft.getAttribute("disabled")).toBeNull();
  } finally {
    first.resolve({ timeZone: null });
    await navigation;
    route.options.loader = loader;
  }
});

test("switching conversations keeps navigation while showing only the target loading state", async () => {
  const { router, page } = await renderRoute("/messages/agent-1");
  const navigation = page.getByRole("navigation", { name: "Agent conversations" });
  const gate = Promise.withResolvers<DirectConversationView>();
  loadDirectConversation.mockImplementationOnce(() => gate.promise);
  let navigationDone: Promise<void> | undefined;
  try {
    await act(async () => {
      navigationDone = router.navigate({
        to: "/messages/$agentId",
        params: { agentId: "agent-2" },
      });
    });
    await waitFor(() => expect(page.getByRole("status").textContent).toContain("Loading messages"));
    expect(page.getByRole("navigation", { name: "Agent conversations" })).toBe(navigation);
    expect(page.getByRole("link", { name: /First Agent/ })).toBeTruthy();
    expect(page.queryByRole("heading", { name: "First Agent" })).toBeNull();
    expect(page.queryByRole("textbox", { name: "Message" })).toBeNull();
    await act(async () => {
      gate.resolve({
        conversationId: "conversation-agent-2",
        senderMemberId: "member-1",
        agent: agents[1],
        messages: [],
      });
      await navigationDone;
    });
    expect(page.getByRole("heading", { name: "Second Agent" })).toBeTruthy();
    expect(page.queryByText("Loading messages…")).toBeNull();
  } finally {
    gate.resolve({
      conversationId: "conversation-agent-2",
      senderMemberId: "member-1",
      agent: agents[1],
      messages: [],
    });
    await navigationDone;
  }
});

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
  loadDirectConversationUpdates.mockClear();
  sendDirectConversationMessage.mockClear();
  loadPublicChannelUpdates.mockClear();
  sendPublicChannelMessage.mockClear();
  getUserProfile.mockClear();
  loadWorkspaceSwitcher.mockClear();
});

test("a channel load failure stays inside the conversation and retries in place", async () => {
  const { router, page } = await renderRoute("/messages/agent-1");
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof loadPublicChannel>>>();
  loadPublicChannel.mockImplementationOnce(() => gate.promise);
  let navigationDone: Promise<void> | undefined;
  try {
    await act(async () => {
      navigationDone = router.navigate({
        to: "/messages/channels/$channelId",
        params: { channelId: "channel-1" },
      });
    });
    await waitFor(() => expect(page.getByRole("status").textContent).toContain("Loading messages"));
    await act(async () => {
      gate.reject(new Error("Unavailable"));
      await navigationDone;
    });
    expect(page.getByRole("alert").textContent).toContain("Messages could not be loaded");
    expect(page.getByRole("link", { name: /First Agent/ })).toBeTruthy();
    expect(page.queryByRole("textbox", { name: "Message" })).toBeNull();
    const agentLink = page.getByRole("link", { name: /First Agent/ });
    await userEvent.setup().click(page.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(page.getByRole("heading", { name: "#general" })).toBeTruthy());
    expect(page.queryByRole("alert")).toBeNull();
    expect(page.getByRole("link", { name: /First Agent/ })).toBe(agentLink);
  } finally {
    gate.resolve({
      conversationId: "channel-1",
      name: "general",
      senderMemberId: "member-1",
      muted: false,
      messages: [],
    });
    await navigationDone;
  }
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

test("Agent list loads in place then keeps its cards and filter during refresh", async () => {
  const { router, page } = await renderRoute("/messages/agent-1");
  const firstLoad = Promise.withResolvers<typeof agents>();
  listAgents.mockImplementationOnce(() => firstLoad.promise);
  let navigationDone: Promise<void> | undefined;
  try {
    await act(async () => {
      navigationDone = router.navigate({ to: "/agents" });
    });
    await waitFor(() => expect(page.getByRole("status").textContent).toContain("Loading Agents"));
    expect(page.getByRole("heading", { name: "Agent overview" })).toBeTruthy();
    expect(page.queryByText("No agents yet")).toBeNull();
    await act(async () => {
      firstLoad.resolve(agents);
      await navigationDone;
    });
    const search = page.getByRole("searchbox", { name: "Search agents" });
    await userEvent.setup().type(search, "Second");
    const refresh = Promise.withResolvers<typeof agents>();
    listAgents.mockImplementationOnce(() => refresh.promise);
    let refreshed: Promise<void> | undefined;
    try {
      await act(async () => {
        refreshed = router.invalidate({ sync: true });
      });
      expect(page.getByRole("heading", { name: "Second Agent" })).toBeTruthy();
      expect(page.queryByText("Loading Agents…")).toBeNull();
      expect(page.getByRole("searchbox", { name: "Search agents" })).toBe(search);
    } finally {
      await act(async () => {
        refresh.resolve(agents);
        await refreshed;
      });
    }
    expect(page.getByRole("searchbox", { name: "Search agents" }).getAttribute("value")).toBe(
      "Second",
    );
  } finally {
    firstLoad.resolve(agents);
    await navigationDone;
  }
});

test("the messages index selects the first Agent", async () => {
  const { router, page } = await renderRoute("/messages");
  await waitFor(() => expect(router.state.location.pathname).toBe("/messages/agent-1"));
  expect(page.getByRole("heading", { name: "First Agent" })).toBeTruthy();
  expect(loadDirectConversation).toHaveBeenCalledWith({
    data: { agentId: "agent-1" },
  });
});

test("entering messages shows its layout while the conversation list is loading", async () => {
  const { router, page } = await renderRoute("/agents");
  const gate = Promise.withResolvers<typeof agents>();
  listAgents.mockImplementationOnce(() => gate.promise);
  let navigationDone: Promise<void> | undefined;
  try {
    await act(async () => {
      navigationDone = router.navigate({
        to: "/messages/$agentId",
        params: { agentId: "agent-1" },
      });
    });
    await waitFor(() => expect(page.getByRole("heading", { name: "Messages" })).toBeTruthy());
    expect(page.getByRole("status").textContent).toContain("Loading messages");
    expect(
      page.getByRole("navigation", { name: "Agent conversations" }).getAttribute("aria-busy"),
    ).toBe("true");
  } finally {
    await act(async () => {
      gate.resolve(agents);
      await navigationDone;
    });
  }
  expect(page.getByRole("heading", { name: "First Agent" })).toBeTruthy();
});

test("a direct URL renders the second Agent through the Outlet and highlights it", async () => {
  const { router, page } = await renderRoute("/messages/agent-2");
  expect(router.state.location.pathname).toBe("/messages/agent-2");
  await waitFor(() => expect(page.getByRole("heading", { name: "Second Agent" })).toBeTruthy());
  expect(page.getByRole("link", { name: /Second Agent/ }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(loadDirectConversation).toHaveBeenCalledWith({
    data: { agentId: "agent-2" },
  });
});

test("a sent direct message renders immediately and reconciles unseen messages", async () => {
  const user = userEvent.setup();
  const { page } = await renderRoute("/messages/agent-1");

  await user.type(page.getByRole("textbox", { name: "Message" }), "Show this immediately");
  await user.click(page.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(page.getByText("Show this immediately")).toBeTruthy());
  expect(sendDirectConversationMessage).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(loadDirectConversationUpdates).toHaveBeenCalledTimes(1));
});

test("sending does not advance past an unseen canonical message", async () => {
  const user = userEvent.setup();
  const message = (sequence: number, body: string) => ({
    id: `message-${sequence}`,
    sequence,
    senderKind: sequence === 102 ? ("user" as const) : ("agent" as const),
    senderMemberId: sequence === 102 ? "member-1" : undefined,
    senderName: sequence === 102 ? "@route-tester" : "First Agent",
    body,
    createdAt: new Date(`2026-08-29T00:00:${sequence - 90}Z`),
  });
  loadDirectConversation.mockImplementationOnce(async () => ({
    conversationId: "conversation-agent-1",
    senderMemberId: "member-1",
    agent: agents[0],
    messages: [message(100, "Already loaded")],
  }));
  sendDirectConversationMessage.mockImplementationOnce(async () => message(102, "My reply"));
  loadDirectConversationUpdates.mockImplementationOnce(async ({ data }) => {
    expect(data.afterSequence).toBe(100);
    return [message(101, "Unseen Agent reply")];
  });
  const { page } = await renderRoute("/messages/agent-1");

  await user.type(page.getByRole("textbox", { name: "Message" }), "My reply");
  await user.click(page.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(page.getByText("Unseen Agent reply")).toBeTruthy());
  expect(page.getByText("My reply")).toBeTruthy();
});

test("a late send response cannot enter a different Agent conversation", async () => {
  const user = userEvent.setup();
  let resolveSend = (_value: Awaited<ReturnType<typeof sendDirectConversationMessage>>) => {};
  sendDirectConversationMessage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  );
  const { router, page } = await renderRoute("/messages/agent-1");
  await user.type(page.getByRole("textbox", { name: "Message" }), "Only for First Agent");
  fireEvent.click(page.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendDirectConversationMessage).toHaveBeenCalledTimes(1));

  await act(() =>
    router.navigate({
      to: "/messages/$agentId",
      params: { agentId: "agent-2" },
    }),
  );
  await waitFor(() => expect(page.getByRole("heading", { name: "Second Agent" })).toBeTruthy());
  await act(async () => {
    resolveSend({
      id: "late-agent-1-message",
      sequence: 1,
      senderKind: "user",
      senderMemberId: "member-1",
      senderName: "@route-tester",
      body: "Only for First Agent",
      createdAt: new Date("2026-08-29T00:00:03Z"),
    });
  });

  expect(page.queryByText("Only for First Agent")).toBeNull();
});

test("channel URL uses the shared messages layout and selects the channel", async () => {
  const { page } = await renderRoute("/messages/channels/channel-1");
  expect(page.getByRole("heading", { name: "#general", level: 1 })).toBeTruthy();
  expect(page.getByRole("link", { name: /general/ }).getAttribute("aria-current")).toBe("page");
  expect(page.getByRole("button", { name: "Create channel" })).toBeTruthy();
  expect(page.getByRole("textbox", { name: "Message" })).toBeTruthy();
});

test("channel message index is scoped by its conversation ID", async () => {
  const user = userEvent.setup();
  const { page } = await renderRoute("/messages/channels/channel-1");

  await user.click(page.getByRole("button", { name: "Your messages" }));

  await waitFor(() =>
    expect(loadOwnConversationMessages).toHaveBeenCalledWith({
      data: { conversationId: "channel-1", beforeSequence: undefined },
    }),
  );
  await user.click(page.getByText("Own message in channel-1"));
  expect(loadConversationAround).toHaveBeenCalledWith({
    data: { conversationId: "channel-1", messageId: "own-channel-1" },
  });
});

test("a sent channel message renders immediately and reconciles unseen messages", async () => {
  const user = userEvent.setup();
  const { page } = await renderRoute("/messages/channels/channel-1");

  await user.type(page.getByRole("textbox", { name: "Message" }), "Channel update");
  await user.click(page.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(page.getByText("Channel update")).toBeTruthy());
  expect(sendPublicChannelMessage).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(loadPublicChannelUpdates).toHaveBeenCalledTimes(1));
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
  const { page, router } = await renderRoute("/agents/agent-1?tab=profile");
  expect(page.getByRole("heading", { name: "First Agent" })).toBeTruthy();
  expect(page.getByRole("img", { name: "First Agent, Offline" })).toBeTruthy();
  expect(page.getByText("Offline")).toBeTruthy();
  expect(page.getByText("computer…5678")).toBeTruthy();
  expect(page.getByRole("alert").textContent).toContain("Agent runtime could not be started.");
  const reason =
    "Original session history was not found. A new session was started; previous context was not restored.";
  await act(() =>
    router.navigate({
      to: "/agents/$agentId",
      params: { agentId: "agent-1" },
      search: { tab: "activity" },
    }),
  );
  await act(async () =>
    publishActivity({
      channel: "activity:workspace-1",
      data: encodeAgentActivity({
        protocolMajor: 1,
        requestId: "new-session-after-missing",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        launchId: "launch-recovery",
        clientSeq: 1,
        detailKind: "other",
        level: "info",
        detail: reason,
        observedAtMs: Date.now(),
      }),
    }),
  );
  expect(page.getByText(reason)).toBeTruthy();
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

test("live thinking displays its label and the unchanged provider text", async () => {
  const { page } = await renderRoute("/agents/agent-1?tab=activity");
  await act(async () =>
    publishActivity({
      channel: "activity:workspace-1",
      data: encodeAgentActivity({
        protocolMajor: 1,
        requestId: "thinking",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        launchId: "launch-2",
        clientSeq: 1,
        detailKind: "thinking_started",
        level: "info",
        detail: "Checking the saved conversation before replying.",
        observedAtMs: Date.now(),
      }),
    }),
  );
  expect(page.getByText("Thinking")).toBeTruthy();
  expect(page.getByText("Checking the saved conversation before replying.")).toBeTruthy();
  expect(page.queryByText("Other: thinking_started")).toBeNull();
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
        detailKind: "starting",
        level: "info",
        detail: "Starting",
        observedAtMs: Date.parse("2026-08-29T00:00:03Z"),
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
    detailKind: "turn_completed",
    level: "info" as const,
    detail: "Agent turn completed.",
    observedAtMs: Date.parse("2026-08-29T00:00:03Z"),
  };
  await act(async () => {
    publishActivity({
      channel: "activity:workspace-1",
      data: encodeAgentActivity({ ...event, agentId: "agent-2" }),
    });
  });
  expect(page.queryByText("Idle")).toBeNull();
  await act(async () => {
    const publication = {
      channel: "activity:workspace-1",
      data: encodeAgentActivity(event),
    };
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
          detailKind: "using_tool",
          level: "info",
          detail: "Live during reload",
          observedAtMs: Date.parse("2026-08-29T00:00:04Z"),
        }),
      }),
    );
    expect(page.getByText("Live during reload")).toBeTruthy();
    extraHistory = [
      {
        id: "persisted-missed",
        launchId: "launch-2",
        clientSeq: 1,
        detailKind: "using_tool",
        level: "info",
        detail: "Recovered history",
        observedAtMs: Date.parse("2026-08-29T00:00:03Z"),
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
