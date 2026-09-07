import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { Subscription } from "centrifuge";

import { useBrowserRealtime } from "../realtime/browser-realtime";
import { getConversationRealtimeToken } from "../realtime/realtime.functions";
import { conversationRealtimeChannel, decodeMessageAvailableEvent } from "./conversation-realtime";

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
      if (event.conversationId === input.conversationId) requestReconciliation();
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

export function useConversationRealtime(conversationId: string, reconcile: () => Promise<void>) {
  const client = useBrowserRealtime();
  const getToken = useServerFn(getConversationRealtimeToken);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  useEffect(() => {
    if (!client) return;
    return subscribeToConversationRealtime<Subscription>(client, {
      conversationId,
      getToken: () => getToken({ data: { conversationId } }),
      reconcile: () => void reconcileRef.current().catch(() => {}),
    });
  }, [client, conversationId, getToken]);
}
