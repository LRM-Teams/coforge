import { describe, expect, test } from "bun:test";

import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";

import { createConversationReconciler } from "#src/features/conversations/conversation-reconciliation";
import { onNetworkRead } from "#src/features/conversations/conversation-queries";
import {
  decodeChannelCreatedEvent,
  decodeChannelUpdatedEvent,
  decodeMessageAvailableEvent,
  decodeNotificationAvailableEvent,
  decodeViewerEvent,
} from "#src/features/conversations/conversation-realtime";

describe("conversation realtime", () => {
  test("decodes only the versioned channel-updated contract", () => {
    const event = {
      type: "channel.updated.v1" as const,
      conversationId: "conversation-a",
      workspaceId: "workspace-a",
    };
    expect(decodeChannelUpdatedEvent(event)).toEqual(event);
    expect(decodeChannelUpdatedEvent(new TextEncoder().encode(JSON.stringify(event)))).toEqual(
      event,
    );
    expect(() => decodeChannelUpdatedEvent({ ...event, type: "member.changed.v1" })).toThrow();
    expect(() => decodeChannelUpdatedEvent({ ...event, workspaceId: "" })).toThrow();
  });

  test("a channel event carries the channel's info, or that it is gone, for a sidebar to apply", () => {
    const ids = { workspaceId: "workspace-a", conversationId: "conversation-a" };
    const channel = { name: "lab", description: "Where we test", archived: false };
    const updated = { type: "channel.updated.v1" as const, ...ids, channel };
    const gone = { type: "channel.updated.v1" as const, ...ids, gone: true as const };
    const created = { type: "channel.created.v1" as const, ...ids, channel };
    expect(decodeChannelUpdatedEvent(updated)).toEqual(updated);
    expect(decodeChannelUpdatedEvent(gone)).toEqual(gone);
    expect(decodeChannelCreatedEvent(created)).toEqual(created);
    // Ids alone still decode (a page can meet an older server), and ask for a read.
    expect(decodeChannelCreatedEvent({ type: "channel.created.v1", ...ids })).toEqual({
      type: "channel.created.v1",
      ...ids,
    });
    expect(() =>
      decodeChannelUpdatedEvent({ ...updated, channel: { ...channel, archived: "no" } }),
    ).toThrow();
  });

  test("decodes the viewer's own channel events, which name only ids, the unread count and the read cursor", () => {
    const ids = { workspaceId: "workspace-a", conversationId: "conversation-a" };
    const marked = {
      type: "channel.marked.v1" as const,
      ...ids,
      unreadCount: 3,
      readThroughSequence: 12,
    };
    expect(decodeViewerEvent(marked)).toEqual(marked);
    expect(decodeViewerEvent(new TextEncoder().encode(JSON.stringify(marked)))).toEqual(marked);
    for (const type of [
      "channel.joined.v1",
      "channel.left.v1",
      "channel.closed.v1",
      "channel.opened.v1",
    ] as const)
      expect(decodeViewerEvent({ type, ...ids })).toEqual({ type, ...ids });
    for (const name of ["muted", "pins"] as const)
      expect(
        decodeViewerEvent({ type: "pref.changed.v1", workspaceId: "workspace-a", name }),
      ).toEqual({ type: "pref.changed.v1", workspaceId: "workspace-a", name });

    expect(decodeViewerEvent({ ...marked, unreadCount: -1 })).toBeUndefined();
    expect(decodeViewerEvent({ ...marked, unreadCount: 1.5 })).toBeUndefined();
    expect(decodeViewerEvent({ ...marked, conversationId: "" })).toBeUndefined();
    expect(decodeViewerEvent({ type: "channel.joined.v1", workspaceId: "w" })).toBeUndefined();
    expect(
      decodeViewerEvent({ type: "pref.changed.v1", workspaceId: "w", name: "theme" }),
    ).toBeUndefined();
    // The same `chat:user:` channel carries message and notification signals; the viewer decoder
    // passes them by.
    expect(
      decodeViewerEvent({
        type: "message.available.v1",
        conversationId: "conversation-a",
        messageId: "message-a",
        sequence: 1,
      }),
    ).toBeUndefined();
  });

  test("decodes the viewer's own DM events alike", () => {
    const ids = { workspaceId: "workspace-a", conversationId: "dm-a" };
    const marked = {
      type: "dm.marked.v1" as const,
      ...ids,
      unreadCount: 2,
      readThroughSequence: 4,
    };
    expect(decodeViewerEvent(marked)).toEqual(marked);
    for (const type of ["dm.created.v1", "dm.opened.v1", "dm.closed.v1"] as const)
      expect(decodeViewerEvent({ type, ...ids })).toEqual({ type, ...ids });
    expect(decodeViewerEvent({ ...marked, unreadCount: -2 })).toBeUndefined();
    // A move always says where the cursor stands.
    expect(decodeViewerEvent({ type: "dm.marked.v1", ...ids, unreadCount: 2 })).toBeUndefined();
    expect(decodeViewerEvent({ type: "dm.joined.v1", ...ids })).toBeUndefined();
  });

  test("decodes the viewer's own saved events, which name the message only", () => {
    const ids = { workspaceId: "workspace-a", conversationId: "conversation-a", messageId: "m-1" };
    for (const type of ["saved.added.v1", "saved.removed.v1"] as const)
      expect(decodeViewerEvent({ type, ...ids })).toEqual({ type, ...ids });
    expect(decodeViewerEvent({ type: "saved.added.v1", ...ids, messageId: "" })).toBeUndefined();
    expect(
      decodeViewerEvent({ type: "saved.added.v1", workspaceId: "w", conversationId: "c" }),
    ).toBeUndefined();
  });

  test("decodes only the versioned message-available contract", () => {
    const event = {
      type: "message.available.v1" as const,
      conversationId: "conversation-a",
      messageId: "message-a",
      sequence: 12,
    };

    expect(decodeMessageAvailableEvent(event)).toEqual(event);
    expect(decodeMessageAvailableEvent(new TextEncoder().encode(JSON.stringify(event)))).toEqual(
      event,
    );
    expect(() => decodeMessageAvailableEvent({ ...event, type: "message.available.v2" })).toThrow();
    expect(() => decodeMessageAvailableEvent({ ...event, sequence: 0 })).toThrow();
    // A person's message names them, so their own pages never count it unread.
    const own = { ...event, senderUserId: "user-a" };
    expect(decodeMessageAvailableEvent(own)).toEqual(own);
    // The `chat:user:` channel also carries `notification.available.v1`; the message decoder
    // must reject it so a subscriber ignoring undecodable publications skips it cleanly.
    expect(() =>
      decodeMessageAvailableEvent({
        type: "notification.available.v1",
        messageId: "message-a",
        workspaceId: "workspace-a",
      }),
    ).toThrow();
  });

  test("carries the sender's idempotency key so the sender's browser can match its pending message", () => {
    const event = {
      type: "message.available.v1" as const,
      conversationId: "conversation-a",
      messageId: "message-a",
      sequence: 12,
      idempotencyKey: "5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
    };
    expect(decodeMessageAvailableEvent(event)).toEqual(event);
    expect(() => decodeMessageAvailableEvent({ ...event, idempotencyKey: "" })).toThrow();
    expect(() => decodeMessageAvailableEvent({ ...event, idempotencyKey: 7 })).toThrow();
  });

  test("decodes only the versioned notification-available contract, carrying no message text", () => {
    const event = {
      type: "notification.available.v1" as const,
      messageId: "message-a",
      workspaceId: "workspace-a",
    };

    expect(decodeNotificationAvailableEvent(event)).toEqual(event);
    expect(
      decodeNotificationAvailableEvent(new TextEncoder().encode(JSON.stringify(event))),
    ).toEqual(event);
    expect(() =>
      decodeNotificationAvailableEvent({ ...event, type: "notification.available.v2" }),
    ).toThrow();
    expect(() => decodeNotificationAvailableEvent({ ...event, messageId: "" })).toThrow();
    expect(() => decodeNotificationAvailableEvent({ ...event, workspaceId: "" })).toThrow();
    expect(() =>
      decodeNotificationAvailableEvent({ type: event.type, messageId: "message-a" }),
    ).toThrow();
    // Never carries message text: an extra `body` field is not part of the contract, but the
    // decoder only reads the fields it knows, matching `decodeMessageAvailableEvent`'s style.
    expect(decodeNotificationAvailableEvent({ ...event, body: "leaked text" })).toEqual(event);
  });

  test("drains full HTTP pages from a canonical cursor without skipping gaps", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      id: `message-${index + 1}`,
      sequence: index + 1,
    }));
    const cursors: number[] = [];
    const merged: typeof messages = [];
    const reconciler = createConversationReconciler(
      { afterSequence: 0 },
      async ({ afterSequence }) => {
        cursors.push(afterSequence);
        return messages.filter((message) => message.sequence > afterSequence).slice(0, 100);
      },
      (page) => merged.push(...page),
    );

    await reconciler.reconcile();

    expect(cursors).toEqual([0, 100, 200]);
    expect(merged).toEqual(messages);
  });

  test("starts from a cursor for roots and a later one for replies, and continues from one", async () => {
    // Roots 1 and 5 are loaded, and so are the replies to them through 40; what arrived after is a
    // root at 41 and a reply at 42, then more of both.
    const cursors: unknown[] = [];
    const arrived = [
      { id: "root-41", sequence: 41 },
      { id: "reply-42", sequence: 42 },
    ];
    const reconciler = createConversationReconciler(
      { afterSequence: 5, afterReplySequence: 40 },
      async (cursor) => {
        cursors.push(cursor);
        return cursors.length === 1 ? arrived : [];
      },
      () => {},
    );

    await reconciler.reconcile();
    await reconciler.reconcile();

    // Nothing more than the first read needed the reply cursor: what it returned settles both.
    expect(cursors).toEqual([{ afterSequence: 5, afterReplySequence: 40 }, { afterSequence: 42 }]);
  });

  test("keeps both cursors while nothing has arrived", async () => {
    const cursors: unknown[] = [];
    const reconciler = createConversationReconciler(
      { afterSequence: 5, afterReplySequence: 40 },
      async (cursor) => {
        cursors.push(cursor);
        return [];
      },
      () => {},
    );

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(cursors).toEqual([
      { afterSequence: 5, afterReplySequence: 40 },
      { afterSequence: 5, afterReplySequence: 40 },
    ]);
  });

  test("starts from the window's newer read, not an older copy it opened from", async () => {
    // The window opened from a stored copy ending at 10; its network read then brought it to 500.
    const cursors: unknown[] = [];
    const reconciler = createConversationReconciler(
      { afterSequence: 10, afterReplySequence: 12 },
      async (cursor) => {
        cursors.push(cursor);
        return [];
      },
      () => {},
    );
    reconciler.advance({ afterSequence: 500, afterReplySequence: 510 });
    // A read of an older window (one that slid back into history) does not move it back.
    reconciler.advance({ afterSequence: 200 });

    await reconciler.reconcile();

    expect(cursors).toEqual([{ afterSequence: 500, afterReplySequence: 510 }]);
  });

  test("hears the window's own network reads, not the page's own writes to it", async () => {
    // A sent message merged into the window must not move the reconciler past messages from
    // others that arrived before it and are still unread.
    const queryClient = new QueryClient();
    const key = ["conversation", "channel", "c1"];
    const heard: unknown[] = [];
    const stop = onNetworkRead(queryClient, key, (data) => heard.push(data));
    queryClient.setQueryData(key, { sent: 105 });
    await queryClient.fetchQuery({ queryKey: key, queryFn: async () => ({ read: 105 }) });
    queryClient.setQueryData(["conversation", "channel", "c2"], { other: true });
    stop();
    expect(heard).toEqual([{ read: 105 }]);
  });

  test("does not count loading older or newer pages as a read of the newest one", async () => {
    // Loading more keeps the pages already held as they were, the viewer's own merges included.
    const queryClient = new QueryClient();
    const key = ["conversation", "channel", "c1"];
    const options = {
      queryKey: key,
      queryFn: async ({ pageParam }: { pageParam: number }) => ({ page: pageParam }),
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      getPreviousPageParam: (first: { page: number }) => first.page - 1,
    };
    await queryClient.fetchInfiniteQuery(options);
    const heard: unknown[] = [];
    const stop = onNetworkRead(queryClient, key, (data) => heard.push(data));
    await new InfiniteQueryObserver(queryClient, options).fetchPreviousPage();
    stop();
    expect(heard).toEqual([]);
  });

  test("coalesces a signal received while reconciliation is in flight", async () => {
    let releaseFirstPage = () => {};
    let calls = 0;
    const firstPage = new Promise<Array<{ id: string; sequence: number }>>((resolve) => {
      releaseFirstPage = () => resolve([{ id: "message-1", sequence: 1 }]);
    });
    const reconciler = createConversationReconciler(
      { afterSequence: 0 },
      async () => (++calls === 1 ? firstPage : []),
      () => {},
    );

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    releaseFirstPage();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
  });
});
