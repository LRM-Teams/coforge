import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  useBrowserRealtime,
  type BrowserRealtimeSubscription,
} from "#src/features/realtime/browser-realtime";
import { getConversationRealtimeToken } from "#src/features/realtime/realtime.functions";
import { subscriptionGap, type SubscribedRecovery } from "#src/features/realtime/subscription-gap";
import {
  conversationRealtimeChannel,
  decodeChannelUpdatedEvent,
  decodeMemberChangedEvent,
  decodeMessageAvailableEvent,
} from "./conversation-realtime";
import { deviceComposerOutbox } from "./use-message-outbox";

/** Which member lists a missed membership change may have stale-dated (see `onMemberChanged`). */
export type MemberDirectoryStale = "page-payload" | "all";

type RealtimeSubscription = {
  on(event: "subscribed", listener: (context: SubscribedRecovery) => void): unknown;
  on(event: "publication", listener: (context: { data: unknown }) => void): unknown;
  subscribe(): void;
  unsubscribe(): void;
};

type RealtimeClient<T extends RealtimeSubscription> = {
  newSubscription(
    channel: string,
    options: {
      recoverable: boolean;
      positioned: boolean;
      getToken: () => Promise<string>;
    },
  ): T;
  removeSubscription(subscription: T): void;
};

export function subscribeToConversationRealtime<T extends RealtimeSubscription>(
  client: RealtimeClient<T>,
  input: {
    conversationId: string;
    getToken: () => Promise<string>;
    reconcile: () => void;
    /** A membership change in this conversation (join/leave/add/remove) may have gone unseen:
     * the member directory (composer candidates, plain-@handle resolution) must be refetched.
     * `"page-payload"`: the first subscribe, which covers what changed while the page loaded, so
     * only the lists read before it (the page payload's) are stale; a list the browser first
     * read after hydration was read about as late as the subscribe. `"all"`: a
     * `member.changed.v1` publication, or a resubscribe that lost publications. */
    onMemberChanged?: (stale: MemberDirectoryStale) => void;
    /** This channel was renamed, described, archived or unarchived: the page's own copy of those
     * facts is stale and must be refetched. */
    onChannelUpdated?: () => void;
    /** A message the viewer sent from the browser now exists: its signal names the send's request
     * id, so the page can swap its greyed pending copy for the real message (see
     * `composer-outbox.ts`). */
    onSentMessage?: (requestId: string, messageId: string) => void;
  },
) {
  const channel = conversationRealtimeChannel(input.conversationId);
  const requestReconciliation = () => {
    if (document.visibilityState === "visible") input.reconcile();
  };
  const subscription = client.newSubscription(channel, {
    recoverable: true,
    positioned: true,
    getToken: input.getToken,
  });
  subscription.on("subscribed", (context) => {
    // Anything the subscription could not replay — before the first subscribe, or across a
    // resubscribe that lost publications — may include a member change as well as messages.
    const gap = subscriptionGap(context);
    if (gap === "none") return;
    requestReconciliation();
    input.onMemberChanged?.(gap === "unrecovered" ? "page-payload" : "all");
  });
  subscription.on("publication", ({ data }) => {
    try {
      const event = decodeMessageAvailableEvent(data);
      if (event.conversationId !== input.conversationId) return;
      if (event.requestId) input.onSentMessage?.(event.requestId, event.messageId);
      requestReconciliation();
      return;
    } catch {}
    // Not a message event: the other payloads this channel carries are a membership change,
    // which stale-dates the member directory, and a change to the channel's own facts. Neither
    // touches the message window.
    try {
      const event = decodeMemberChangedEvent(data);
      if (event.conversationId === input.conversationId) input.onMemberChanged?.("all");
      return;
    } catch {}
    try {
      const event = decodeChannelUpdatedEvent(data);
      if (event.conversationId === input.conversationId) input.onChannelUpdated?.();
    } catch {}
  });
  const onVisibilityChange = () => requestReconciliation();
  const onOnline = () => requestReconciliation();
  const safetyTimer = window.setInterval(requestReconciliation, 30_000);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onOnline);
  subscription.subscribe();
  return () => {
    window.clearInterval(safetyTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", onOnline);
    subscription.unsubscribe();
    client.removeSubscription(subscription);
  };
}

export function useConversationRealtime(
  conversationId: string,
  reconcile: () => Promise<void>,
  onMemberChanged?: (stale: MemberDirectoryStale) => void,
  onChannelUpdated?: () => void,
) {
  const client = useBrowserRealtime();
  const getToken = useServerFn(getConversationRealtimeToken);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  const memberChangedRef = useRef(onMemberChanged);
  memberChangedRef.current = onMemberChanged;
  const channelUpdatedRef = useRef(onChannelUpdated);
  channelUpdatedRef.current = onChannelUpdated;

  useEffect(() => {
    if (!client || !conversationId) return;
    return subscribeToConversationRealtime<BrowserRealtimeSubscription>(client, {
      conversationId,
      getToken: () => getToken({ data: { conversationId } }),
      reconcile: () => void reconcileRef.current().catch(() => {}),
      onMemberChanged: (stale) => memberChangedRef.current?.(stale),
      onChannelUpdated: () => channelUpdatedRef.current?.(),
      onSentMessage: (requestId, messageId) =>
        deviceComposerOutbox().acknowledge(requestId, messageId),
    });
  }, [client, conversationId, getToken]);
}
