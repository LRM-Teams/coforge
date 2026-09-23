import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  useBrowserRealtime,
  type BrowserRealtimeSubscription,
} from "@/features/realtime/browser-realtime";
import { getConversationRealtimeToken } from "@/features/realtime/realtime.functions";
import {
  conversationRealtimeChannel,
  decodeMemberChangedEvent,
  decodeMessageAvailableEvent,
} from "./conversation-realtime";
import { deviceComposerOutbox } from "./use-message-outbox";

type RealtimeSubscription = {
  on(
    event: "subscribed",
    listener: (context: { wasRecovering: boolean; recovered: boolean }) => void,
  ): unknown;
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
    /** A membership change in this conversation (join/leave/add/remove): the member directory
     * (composer candidates, plain-@handle resolution) is stale and must be refetched. */
    onMemberChanged?: () => void;
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
  subscription.on("subscribed", ({ wasRecovering, recovered }) => {
    if (!wasRecovering || !recovered) requestReconciliation();
  });
  subscription.on("publication", ({ data }) => {
    try {
      const event = decodeMessageAvailableEvent(data);
      if (event.conversationId !== input.conversationId) return;
      if (event.requestId) input.onSentMessage?.(event.requestId, event.messageId);
      requestReconciliation();
      return;
    } catch {}
    // Not a message event: the other payload this channel carries is a membership change,
    // which stale-dates the member directory but not the message window.
    try {
      const event = decodeMemberChangedEvent(data);
      if (event.conversationId === input.conversationId) input.onMemberChanged?.();
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
  onMemberChanged?: () => void,
) {
  const client = useBrowserRealtime();
  const getToken = useServerFn(getConversationRealtimeToken);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  const memberChangedRef = useRef(onMemberChanged);
  memberChangedRef.current = onMemberChanged;

  useEffect(() => {
    if (!client || !conversationId) return;
    return subscribeToConversationRealtime<BrowserRealtimeSubscription>(client, {
      conversationId,
      getToken: () => getToken({ data: { conversationId } }),
      reconcile: () => void reconcileRef.current().catch(() => {}),
      onMemberChanged: () => memberChangedRef.current?.(),
      onSentMessage: (requestId, messageId) =>
        deviceComposerOutbox().acknowledge(requestId, messageId),
    });
  }, [client, conversationId, getToken]);
}
