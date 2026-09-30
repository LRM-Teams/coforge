import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  createSidebar,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type Arrangement,
  type SidebarApi,
  channelNamesBehind,
  applyChannelSignalToLists,
  listReadPosition,
  loadSidebarLists,
} from "#src/features/conversations/sidebar-collections";
import { compareChannelNames, type ChannelName } from "#src/features/conversations/channel-signals";
import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "#src/features/conversations/conversation-query-keys";
import type { ChatList } from "#src/features/conversations/conversation-unread";
import { savedMessagesQueryKey } from "#src/features/conversations/saved-messages-collection";
import type { StreamPositions } from "#src/features/realtime/subscription-gap";

/**
 * The Chat sidebar's lists and the changes made from the sidebar, against fake server calls: each
 * change shows at once, is saved, and stays as shown or goes back; failed re-reads keep the rows.
 */
type Channel = Awaited<ReturnType<SidebarApi["listChannels"]>>["channels"][number];
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
      streamPositions: {},
    },
    failReads: false,
    channelReads: 0,
  };
  const api: SidebarApi = {
    listChannels: async () => {
      server.channelReads += 1;
      if (server.failReads) throw new Error("offline");
      return { streamPositions: {}, channels: server.channels };
    },
    loadDirectPreferences: async () => {
      if (server.failReads) throw new Error("offline");
      return server.preferences;
    },
    loadDirectBadges: async () => ({ viewerId: "viewer", unread: {}, streamPositions: {} }),
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
const listed = (sidebar: { channels: { toArray: { id: string; name: string }[] } }) =>
  [...sidebar.channels.toArray]
    .sort((a, b) => compareChannelNames(a.name, b.name))
    .map((row) => row.id);

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

test("while a sidebar change is being saved, a channel event asks for a read instead", async () => {
  // A failed save's rollback undoes a direct write made meanwhile, even to another row; a read
  // made meanwhile survives it.
  let failPin!: (error: Error) => void;
  const { sidebar } = await sidebarWith({
    pin: () => new Promise((_, reject) => (failPin = reject)),
  });
  const pinned = sidebar.actions.setPinned({ kind: "channel", channelId: "random" }, true);
  const archiveGeneral = {
    type: "channel.updated.v1" as const,
    ...signalIds,
    conversationId: "general",
    channel: { name: "general", description: "", archived: true },
  };
  expect(sidebar.applyChannelSignal(archiveGeneral, { known: true })).toBe(false);
  failPin(new Error("offline"));
  await pinned.catch(() => undefined);
  expect(sidebar.channels.get("random")?.pinned).toBe(false);
  // Once nothing is pending, events are written again.
  expect(sidebar.applyChannelSignal(archiveGeneral, { known: true })).toBe(true);
  expect(sidebar.channels.get("general")?.archived).toBe(true);
});

test("a channel event before the list has synced asks for a read instead of failing", async () => {
  const { sidebar } = await sidebarWith({}, { synced: false });
  expect(
    sidebar.applyChannelSignal(
      {
        type: "channel.created.v1",
        ...signalIds,
        conversationId: "lab",
        channel: { name: "lab", description: "", archived: false },
      },
      { known: false },
    ),
  ).toBe(false);
});

describe("applyChannelSignalToLists", () => {
  const lab = { name: "lab", description: "", archived: false };
  const streamPositions = { "chat:workspace:w": { offset: 5, epoch: "e1" } };
  type NamesRead = { names: ChannelName[]; streamPositions: typeof streamPositions };
  async function withNames() {
    const setup = await sidebarWith();
    setup.queryClient.setQueryData<NamesRead>(channelNamesQueryKey("w"), {
      streamPositions,
      names: [{ id: "general", name: "general", description: "", archived: false }],
    });
    return setup;
  }

  test("a created channel is written into every channel's name and the list, with no read", async () => {
    const { sidebar, queryClient } = await withNames();
    const stale = applyChannelSignalToLists(queryClient, "w", sidebar, {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "lab",
      channel: lab,
    });
    expect(stale).toEqual([]);
    expect(queryClient.getQueryData<NamesRead>(channelNamesQueryKey("w"))).toEqual({
      // A write from an event is not a server read: the positions the names were read at stay.
      streamPositions,
      names: [
        { id: "general", name: "general", description: "", archived: false },
        { id: "lab", ...lab },
      ],
    });
    expect(listed(sidebar)).toEqual(["general", "lab", "random"]);
  });

  test("an ids-only event, a channel coming back, or no hydrated sidebar is re-read", async () => {
    const { sidebar, queryClient } = await withNames();
    const idsOnly = { type: "channel.updated.v1" as const, ...signalIds, conversationId: "random" };
    expect(applyChannelSignalToLists(queryClient, "w", sidebar, idsOnly)).toEqual([
      "channelNames",
      "channels",
    ]);
    // #general restored: every channel's name had dropped it, so the list cannot place it.
    expect(
      applyChannelSignalToLists(queryClient, "w", sidebar, {
        type: "channel.updated.v1",
        ...signalIds,
        conversationId: "back",
        channel: lab,
      }),
    ).toEqual(["channels"]);
    expect(
      applyChannelSignalToLists(queryClient, "w", undefined, {
        type: "channel.created.v1",
        ...signalIds,
        conversationId: "new",
        channel: lab,
      }),
    ).toEqual(["channels"]);
  });

  test("a list being read when the event lands is read again, so an older answer cannot win", async () => {
    const { sidebar, queryClient } = await withNames();
    const reading = sidebar.channels.utils.refetch();
    const stale = applyChannelSignalToLists(queryClient, "w", sidebar, {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "lab",
      channel: lab,
    });
    expect(stale).toEqual(["channels"]);
    await reading;
  });
});

describe("the DM list's stream positions", () => {
  // The list is two server reads, each taken at the viewer's own signal channel's position.
  const viewerChannel = "chat:user:viewer";
  const at = (offset: number, epoch = "e1") => ({ [viewerChannel]: { offset, epoch } });
  async function directsRead(
    read: {
      preferences: StreamPositions;
      badges: StreamPositions;
      failing?: "preferences" | "badges";
    },
    tolerant = false,
  ) {
    const server = {
      channels: [],
      preferences: { conversations: [], pinned: [], hidden: [], streamPositions: read.preferences },
    };
    const api: SidebarApi = {
      ...serverlessApi(server),
      loadDirectPreferences: async () => {
        if (read.failing === "preferences") throw new Error("offline");
        return server.preferences;
      },
      loadDirectBadges: async () => {
        if (read.failing === "badges") throw new Error("offline");
        return { viewerId: "viewer", unread: {}, streamPositions: read.badges };
      },
    };
    return new QueryClient().query(sidebarDirectsQuery("w", { tolerant, api }));
  }

  test("the list stands at the older of its two reads, per channel", async () => {
    expect((await directsRead({ preferences: at(9), badges: at(7) })).streamPositions).toEqual(
      at(7),
    );
    expect((await directsRead({ preferences: at(3), badges: at(7) })).streamPositions).toEqual(
      at(3),
    );
  });

  test("reads in different epochs, or a channel only one read has, leave no position", async () => {
    expect(
      (await directsRead({ preferences: at(9, "e2"), badges: at(7, "e1") })).streamPositions,
    ).toEqual({});
    expect((await directsRead({ preferences: {}, badges: at(7) })).streamPositions).toEqual({});
    expect((await directsRead({ preferences: at(7), badges: {} })).streamPositions).toEqual({});
  });

  test("a first load that fell back on a failed read has no position, though the other read has", async () => {
    for (const failing of ["preferences", "badges"] as const) {
      const directs = await directsRead({ preferences: at(7), badges: at(7), failing }, true);
      expect(directs).toMatchObject({ partial: true, streamPositions: {} });
    }
  });
});

describe("listReadPosition", () => {
  const channel = "chat:user:viewer";
  const readAt = (offset: number, epoch = "e1") => ({
    streamPositions: { [channel]: { offset, epoch } },
  });

  test("finds where each list was last read, in that list's own query", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sidebarChannelsQueryKey("w"), { rows: [], ...readAt(1) });
    queryClient.setQueryData(sidebarDirectsQueryKey("w"), { rows: [], ...readAt(2) });
    queryClient.setQueryData(channelNamesQueryKey("w"), { names: [], ...readAt(3) });
    queryClient.setQueryData(savedMessagesQueryKey("w"), { entries: [], ...readAt(4) });
    const lists: ChatList[] = ["channels", "dms", "channelNames", "saved"];
    expect(
      await Promise.all(lists.map((list) => listReadPosition(queryClient, "w", list, channel))),
    ).toEqual([1, 2, 3, 4].map((offset) => ({ offset, epoch: "e1" })));
  });

  test("a list read without a position for the channel, or not read, has none", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(channelNamesQueryKey("w"), { names: [], ...readAt(3) });
    queryClient.setQueryData(savedMessagesQueryKey("w"), { entries: [], streamPositions: {} });
    expect(await listReadPosition(queryClient, "w", "channelNames", "chat:workspace:w")).toBe(
      undefined,
    );
    expect(await listReadPosition(queryClient, "w", "saved", channel)).toBe(undefined);
    expect(await listReadPosition(queryClient, "w", "dms", channel)).toBe(undefined);
  });

  test("a read under way settles first, and its position is the one reported", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(savedMessagesQueryKey("w"), { entries: [], ...readAt(3) });
    let settle: (read: unknown) => void = () => {};
    const answer = new Promise<unknown>((resolve) => (settle = resolve));
    const reading = queryClient.fetchQuery({
      queryKey: savedMessagesQueryKey("w"),
      queryFn: () => answer,
      staleTime: 0,
    });
    const position = listReadPosition(queryClient, "w", "saved", channel);
    settle({ entries: [], ...readAt(8) });
    await reading;
    expect(await position).toEqual({ offset: 8, epoch: "e1" });
  });
});

describe("loadSidebarLists", () => {
  // The chat layout's loader runs on every navigation inside Chat. The lists stay live through
  // realtime (and a subscribe's gap re-read), so a navigation reads only what is not cached.
  async function counted() {
    const reads = { channels: 0, directs: 0 };
    const { server, queryClient } = await sidebarWith();
    const api: SidebarApi = {
      ...serverlessApi(server),
      listChannels: async () => {
        reads.channels += 1;
        return { streamPositions: {}, channels: server.channels };
      },
      loadDirectPreferences: async () => {
        reads.directs += 1;
        return server.preferences;
      },
    };
    return { reads, api, fresh: new QueryClient(), queryClient };
  }

  test("a first load reads both lists; moving between chats reads neither", async () => {
    const { reads, api, fresh } = await counted();
    await loadSidebarLists(fresh, "w", "enter", api);
    expect(reads).toEqual({ channels: 1, directs: 1 });
    await loadSidebarLists(fresh, "w", "stay", api);
    await loadSidebarLists(fresh, "w", "enter", api);
    expect(reads).toEqual({ channels: 1, directs: 1 });
  });

  test("a first load that fell back on a failed read is read again on the next navigation", async () => {
    const { reads, api, fresh } = await counted();
    let badgesDown = true;
    const flaky: SidebarApi = {
      ...api,
      loadDirectBadges: async () => {
        if (badgesDown) throw new Error("offline");
        return { viewerId: "viewer", unread: {}, streamPositions: {} };
      },
    };
    await loadSidebarLists(fresh, "w", "enter", flaky);
    expect(fresh.getQueryData(sidebarDirectsQuery("w").queryKey)?.viewerId).toBeUndefined();
    badgesDown = false;
    await loadSidebarLists(fresh, "w", "stay", flaky);
    expect(reads.directs).toBe(2);
    expect(fresh.getQueryData(sidebarDirectsQuery("w").queryKey)?.viewerId).toBe("viewer");
  });

  test("a list marked stale is read on the next navigation, a hover preload never reads", async () => {
    const { reads, api, fresh } = await counted();
    await loadSidebarLists(fresh, "w", "enter", api);
    await fresh.invalidateQueries({ queryKey: sidebarChannelsQuery("w").queryKey });
    await loadSidebarLists(fresh, "w", "preload", api);
    expect(reads).toEqual({ channels: 1, directs: 1 });
    await loadSidebarLists(fresh, "w", "stay", api);
    expect(reads).toEqual({ channels: 2, directs: 1 });
  });
});

/** The fake server's reads as a `SidebarApi`, without the writes. */
function serverlessApi(server: {
  channels: Channel[];
  preferences: Awaited<ReturnType<SidebarApi["loadDirectPreferences"]>>;
}): SidebarApi {
  return {
    listChannels: async () => ({ streamPositions: {}, channels: server.channels }),
    loadDirectPreferences: async () => server.preferences,
    loadDirectBadges: async () => ({ viewerId: "viewer", unread: {}, streamPositions: {} }),
    pin: async () => {},
    markUnread: async () => {},
    close: async () => {},
    arrange: async () => {},
  };
}
