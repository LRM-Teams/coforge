import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  createSidebar,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type Arrangement,
  type SidebarApi,
  channelNamesBehind,
} from "#src/features/conversations/sidebar-collections";

/**
 * The Chat sidebar's lists and the changes made from the sidebar, against fake server calls: each
 * change shows at once, is saved, and stays as shown or goes back; failed re-reads keep the rows.
 */
type Channel = Awaited<ReturnType<SidebarApi["listChannels"]>>[number];
const channel = (id: string, fields: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  joined: true,
  archived: false,
  muted: false,
  unreadCount: 0,
  hidden: false,
  pinned: false,
  pinSortOrder: null,
  ...fields,
});

async function sidebarWith(overrides: Partial<SidebarApi> = {}, { synced = true } = {}) {
  const saves: string[] = [];
  const server = {
    channels: [channel("general"), channel("random", { unreadCount: 2 })],
    preferences: {
      conversations: [
        { conversationId: "dm-helper", peer: { kind: "agent" as const, agentId: "helper" } },
        {
          conversationId: "dm-grace",
          peer: {
            kind: "people" as const,
            userId: "grace",
            username: "grace",
            displayName: "Grace",
            avatarUrl: null,
          },
        },
      ],
      pinned: [{ conversationId: "dm-helper", sortOrder: 0 }],
      hidden: [] as string[],
    },
    failReads: false,
    channelReads: 0,
  };
  const api: SidebarApi = {
    listChannels: async () => {
      server.channelReads += 1;
      if (server.failReads) throw new Error("offline");
      return server.channels;
    },
    loadDirectPreferences: async () => {
      if (server.failReads) throw new Error("offline");
      return server.preferences;
    },
    loadDirectBadges: async () => ({ viewerId: "viewer", unread: {} }),
    pin: async (target, pinned) => void saves.push(`pin ${JSON.stringify(target)} ${pinned}`),
    markUnread: async (target) => void saves.push(`unread ${JSON.stringify(target)}`),
    close: async (target) => void saves.push(`close ${JSON.stringify(target)}`),
    arrange: async () => void saves.push("arrange"),
    ...overrides,
  };
  const queryClient = new QueryClient();
  // As after hydration: the loader has filled both Query keys.
  await queryClient.query(sidebarChannelsQuery("w", api));
  await queryClient.query(sidebarDirectsQuery("w", { api }));
  const sidebar = createSidebar(queryClient, "w", api);
  if (synced) await Promise.all([sidebar.channels.preload(), sidebar.directs.preload()]);
  return { sidebar, saves, server, queryClient };
}

test("marking unread saves even when the row already shows a count", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.markUnread({ kind: "channel", channelId: "random" });
  expect(saves).toEqual([`unread {"kind":"channel","channelId":"random"}`]);
});

test("marking unread a row with no count shows one at once and saves it", async () => {
  const { sidebar, saves } = await sidebarWith();
  const saved = sidebar.actions.markUnread({ kind: "channel", channelId: "general" });
  expect(sidebar.channels.get("general")?.unreadCount).toBe(1);
  await saved;
  expect(saves).toEqual([`unread {"kind":"channel","channelId":"general"}`]);
});

test("marking unread a row already showing a count changes nothing on screen but is saved", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.markUnread({ kind: "channel", channelId: "random" });
  expect(sidebar.channels.get("random")?.unreadCount).toBe(2);
  expect(saves).toEqual([`unread {"kind":"channel","channelId":"random"}`]);
});

test("a change made before the lists have synced (another page) is saved and marks them stale", async () => {
  const { sidebar, saves, queryClient } = await sidebarWith({}, { synced: false });
  const stale = () =>
    [sidebarChannelsQuery("w"), sidebarDirectsQuery("w")].map(
      (query) => queryClient.getQueryState(query.queryKey)?.isInvalidated,
    );
  expect(stale()).toEqual([false, false]);
  await sidebar.actions.markUnread({ kind: "direct", conversationId: "dm-helper" });
  await sidebar.actions.setPinned({ kind: "channel", channelId: "random" }, true);
  await sidebar.actions.close({ kind: "channel", channelId: "random" });
  expect(saves).toEqual([
    `unread {"kind":"direct","conversationId":"dm-helper"}`,
    `pin {"kind":"channel","channelId":"random"} true`,
    `close {"kind":"channel","channelId":"random"}`,
  ]);
  // The next page to show the lists reads them again instead of the copy from before.
  expect(stale()).toEqual([true, true]);
});

test("a pin shows at once, is saved, and stays when a later re-read fails", async () => {
  const { sidebar, saves, server } = await sidebarWith();
  const saved = sidebar.actions.setPinned({ kind: "channel", channelId: "general" }, true);
  expect(sidebar.channels.get("general")?.pinned).toBe(true);
  await saved;
  expect(saves).toEqual([`pin {"kind":"channel","channelId":"general"} true`]);

  server.failReads = true;
  await sidebar.channels.utils.refetch();
  expect(sidebar.channels.get("general")).toMatchObject({ pinned: true, pinSortOrder: 1 });
});

test("a saved change is not a server read: the lists' read time stays", async () => {
  const { sidebar, queryClient } = await sidebarWith();
  const key = sidebarChannelsQuery("w").queryKey;
  const before = queryClient.getQueryState(key)!;
  await sidebar.actions.setPinned({ kind: "channel", channelId: "general" }, true);
  const after = queryClient.getQueryState(key)!;
  // The save wrote the cache (its data is new) but the read time it carries is the old one.
  expect(after.data).not.toBe(before.data);
  expect(after.data?.fetchedAt).toBe(before.data?.fetchedAt);
});

test("a failed save puts the row back and rejects", async () => {
  const { sidebar } = await sidebarWith({
    pin: async () => {
      throw new Error("refused");
    },
  });
  const saved = sidebar.actions.setPinned({ kind: "channel", channelId: "general" }, true);
  await expect(saved).rejects.toThrow("refused");
  expect(sidebar.channels.get("general")?.pinned).toBe(false);
});

test("a failed DM re-read keeps the rows it has", async () => {
  const { sidebar, server } = await sidebarWith();
  server.failReads = true;
  await sidebar.directs.utils.refetch();
  expect(sidebar.directs.get("dm-helper")).toMatchObject({
    pinned: true,
    peer: { kind: "agent", agentId: "helper" },
  });
});

test("a DM row changes by its conversation id, a DM between members as one with an Agent", async () => {
  const { sidebar, saves } = await sidebarWith();
  const pinned = sidebar.actions.setPinned({ kind: "direct", conversationId: "dm-grace" }, true);
  // After the viewer's other pin.
  expect(sidebar.directs.get("dm-grace")).toMatchObject({ pinned: true, pinSortOrder: 1 });
  await pinned;
  const closed = sidebar.actions.close({ kind: "direct", conversationId: "dm-grace" });
  expect(sidebar.directs.get("dm-grace")?.hidden).toBe(true);
  await closed;
  expect(saves).toEqual([
    `pin {"kind":"direct","conversationId":"dm-grace"} true`,
    `close {"kind":"direct","conversationId":"dm-grace"}`,
  ]);
});

test("a change to a row that has left the list is still saved", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.close({ kind: "channel", channelId: "gone" });
  expect(saves).toEqual([`close {"kind":"channel","channelId":"gone"}`]);
});

test("drags are saved one after another, in the order they were made", async () => {
  const started: string[] = [];
  let releaseFirst = () => {};
  let firstStarted = () => {};
  const firstCalled = new Promise<void>((resolve) => (firstStarted = resolve));
  const { sidebar } = await sidebarWith({
    arrange: (arrangement: Arrangement) => {
      const first = arrangement.pins[0];
      const name = first?.kind === "channel" ? first.channelId : "helper";
      started.push(name);
      if (name !== "general") return Promise.resolve();
      firstStarted();
      return new Promise<void>((resolve) => (releaseFirst = resolve));
    },
  });
  const first = sidebar.actions.arrange({
    pins: [{ kind: "channel", channelId: "general" }],
    unpinned: [],
  });
  const second = sidebar.actions.arrange({
    pins: [{ kind: "channel", channelId: "random" }],
    unpinned: [],
  });
  try {
    await firstCalled;
    // The second drag waits for the first save: nothing else has reached the server.
    expect(started).toEqual(["general"]);
  } finally {
    releaseFirst();
  }
  await Promise.all([first, second]);
  expect(started).toEqual(["general", "random"]);
});

test("the channel names are behind the sidebar when a listed channel is missing or renamed there", () => {
  const names = [
    { id: "c1", name: "general" },
    { id: "c2", name: "design" },
  ];
  expect(channelNamesBehind(names, [{ id: "c1", name: "general" }])).toBe(false);
  // Created elsewhere while this page was away from Chat.
  expect(channelNamesBehind(names, [{ id: "c3", name: "launch" }])).toBe(true);
  // Renamed elsewhere.
  expect(channelNamesBehind(names, [{ id: "c2", name: "design-team" }])).toBe(true);
  // The names list closed and archived channels too: fewer rows is not behind.
  expect(channelNamesBehind(names, [])).toBe(false);
});

/** The channel rows' ids in the order the sidebar shows them. */
const listed = (sidebar: { channels: { toArray: { id: string; position: number }[] } }) =>
  [...sidebar.channels.toArray].sort((a, b) => a.position - b.position).map((row) => row.id);

async function signalSidebar() {
  const setup = await sidebarWith();
  const before = setup.server.channelReads;
  return { ...setup, reads: () => setup.server.channelReads - before };
}

const signalIds = { workspaceId: "w" };

test("a channel created elsewhere is listed in name order, not joined, without a read", async () => {
  const { sidebar, reads } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "lab",
      channel: { name: "lab", description: "", archived: false },
    },
    { known: false },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general", "lab", "random"]);
  expect(sidebar.channels.get("lab")).toMatchObject({
    name: "lab",
    joined: false,
    archived: false,
    muted: false,
    unreadCount: 0,
    hidden: false,
    pinned: false,
    pinSortOrder: null,
  });
  expect(reads()).toBe(0);
});

test("a channel created by the viewer on another page keeps the row the list already has", async () => {
  const { sidebar } = await signalSidebar();
  sidebar.applyChannelSignal(
    {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "random",
      channel: { name: "random", description: "", archived: false },
    },
    { known: false },
  );
  expect(sidebar.channels.get("random")).toMatchObject({ joined: true, unreadCount: 2 });
});

test("a rename or archive elsewhere changes the row and its place, without a read", async () => {
  const { sidebar, reads } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    {
      type: "channel.updated.v1",
      ...signalIds,
      conversationId: "random",
      channel: { name: "a-team", description: "", archived: true },
    },
    { known: true },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general", "random"]);
  expect(sidebar.channels.get("random")).toMatchObject({
    name: "a-team",
    archived: true,
    joined: true,
    unreadCount: 2,
  });
  expect(reads()).toBe(0);
});

test("a deleted or hidden channel leaves the list without a read", async () => {
  const { sidebar, reads } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    { type: "channel.updated.v1", ...signalIds, conversationId: "random", gone: true },
    { known: true },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general"]);
  expect(reads()).toBe(0);
});

test("a change to a channel the list leaves out on purpose changes nothing", async () => {
  // A closed channel is known (every channel's name has it) but not listed.
  const { sidebar } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    {
      type: "channel.updated.v1",
      ...signalIds,
      conversationId: "closed",
      channel: { name: "closed", description: "", archived: false },
    },
    { known: true },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general", "random"]);
});

test("a change the list cannot place asks for a read", async () => {
  const { sidebar } = await signalSidebar();
  // #general restored: the viewer's place in it is not in the event.
  expect(
    sidebar.applyChannelSignal(
      {
        type: "channel.updated.v1",
        ...signalIds,
        conversationId: "back",
        channel: { name: "back", description: "", archived: false },
      },
      { known: false },
    ),
  ).toBe(false);
  // An event from an older server names ids only.
  expect(
    sidebar.applyChannelSignal(
      { type: "channel.updated.v1", ...signalIds, conversationId: "random" },
      { known: true },
    ),
  ).toBe(false);
  expect(listed(sidebar)).toEqual(["general", "random"]);
});
