import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  createSidebar,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type Arrangement,
  type SidebarApi,
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

async function sidebarWith(overrides: Partial<SidebarApi> = {}) {
  const saves: string[] = [];
  const server = {
    channels: [channel("general"), channel("random", { unreadCount: 2 })],
    preferences: {
      conversations: ["helper"],
      pinned: [{ agentId: "helper", sortOrder: 0 }],
      hidden: [] as string[],
    },
    failReads: false,
  };
  const api: SidebarApi = {
    listChannels: async () => {
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
  await Promise.all([sidebar.channels.preload(), sidebar.directs.preload()]);
  return { sidebar, saves, server, queryClient };
}

test("marking unread saves even when the row already shows a count", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.markUnread({ kind: "channel", channelId: "random" });
  expect(saves).toEqual([`unread {"kind":"channel","channelId":"random"}`]);
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
  const readAt = () => queryClient.getQueryData(sidebarChannelsQuery("w").queryKey)?.fetchedAt;
  const before = readAt();
  await sidebar.actions.setPinned({ kind: "channel", channelId: "general" }, true);
  expect(readAt()).toBe(before);
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
  expect(sidebar.directs.get("helper")).toMatchObject({ pinned: true, conversation: true });
});

test("a change to a row that has left the list does nothing", async () => {
  const { sidebar } = await sidebarWith();
  await expect(sidebar.actions.close({ kind: "channel", channelId: "gone" })).resolves.toBe(
    undefined,
  );
});

test("drags are saved one after another, in the order they were made", async () => {
  const started: string[] = [];
  let releaseFirst = () => {};
  const { sidebar } = await sidebarWith({
    arrange: (arrangement: Arrangement) => {
      const first = arrangement.pins[0];
      const name = first?.kind === "channel" ? first.channelId : "helper";
      started.push(name);
      return name === "general"
        ? new Promise<void>((resolve) => (releaseFirst = resolve))
        : Promise.resolve();
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
  await Promise.resolve();
  expect(started).toEqual(["general"]);
  releaseFirst();
  await Promise.all([first, second]);
  expect(started).toEqual(["general", "random"]);
});
