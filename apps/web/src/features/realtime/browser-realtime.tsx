import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Centrifuge, type Subscription } from "centrifuge/build/protobuf";

/** The one realtime subscription type for the shared Workspace connection. */
export type BrowserRealtimeSubscription = Subscription;

// `undefined` means no provider above the caller; `null` means the provider's
// connection is not open yet.
const BrowserRealtimeContext = createContext<Centrifuge | null | undefined>(undefined);

export function BrowserRealtimeProvider({
  workspaceId,
  getConnectionToken,
  children,
}: {
  workspaceId?: string;
  getConnectionToken: () => Promise<string>;
  children: ReactNode;
}) {
  const [client, setClient] = useState<Centrifuge | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const next = new Centrifuge(`${protocol}//${location.host}/connection/websocket`, {
      getToken: getConnectionToken,
    });
    setClient(next);
    next.connect();
    return () => {
      setClient(null);
      next.disconnect();
    };
  }, [getConnectionToken, workspaceId]);

  return (
    <BrowserRealtimeContext.Provider value={client}>{children}</BrowserRealtimeContext.Provider>
  );
}

export function useBrowserRealtime() {
  const client = useContext(BrowserRealtimeContext);
  // A subscription hook called in the component that renders the provider sees
  // no client and would silently never subscribe; fail loudly instead.
  if (client === undefined)
    throw new Error("useBrowserRealtime must be called inside BrowserRealtimeProvider");
  return client;
}

export type RealtimePublication = { channel: string; data: unknown };

/**
 * Subscribes one authorized channel on the shared Workspace connection.
 *
 * The `_app` layout owns the only browser connection; features subscribe
 * through this hook and never construct their own Centrifuge client. A channel
 * with a narrower server-issued grant supplies its own `getToken`.
 */
export type RealtimeSubscriptionError = {
  channel: string;
  code: number;
  message: string;
};

/**
 * One real Centrifuge `Subscription` per channel, shared by every `useRealtimeSubscription` call
 * for that channel on this client — `newSubscription` throws "already exists" on a second call for
 * the same channel, and more than one feature legitimately subscribes to the same `chat:user:`
 * channel (the sidebar's unread badges and in-page notifications). The first
 * caller creates and subscribes it; the last caller's cleanup unsubscribes and removes it. Each
 * caller's own `onPublication`/`onSubscribed`/`onError` still only ever sees its own latest
 * closure, exactly as before sharing.
 */
type SharedSubscriptionEntry = {
  subscription: Subscription;
  refCount: number;
  publicationHandlers: Set<(publication: RealtimePublication) => void>;
  subscribedHandlers: Set<() => void>;
  errorHandlers: Set<(error: RealtimeSubscriptionError) => void>;
};

const sharedSubscriptions = new WeakMap<Centrifuge, Map<string, SharedSubscriptionEntry>>();

function acquireSharedSubscription(
  client: Centrifuge,
  channel: string,
  getToken?: () => Promise<string>,
): SharedSubscriptionEntry {
  let byChannel = sharedSubscriptions.get(client);
  if (!byChannel) {
    byChannel = new Map();
    sharedSubscriptions.set(client, byChannel);
  }
  let entry = byChannel.get(channel);
  if (!entry) {
    const subscription = client.newSubscription(channel, getToken ? { getToken } : undefined);
    const publicationHandlers = new Set<(publication: RealtimePublication) => void>();
    const subscribedHandlers = new Set<() => void>();
    const errorHandlers = new Set<(error: RealtimeSubscriptionError) => void>();
    subscription.on("subscribed", () => {
      for (const handler of subscribedHandlers) handler();
    });
    subscription.on("publication", (publication) => {
      for (const handler of publicationHandlers) handler(publication);
    });
    // A rejected or dropped subscription (e.g. Centrifugo's 103: permission
    // denied when no valid subscription token is presented) otherwise fails
    // silently, leaving the feature looking connected but never updating.
    subscription.on("error", (event) => {
      console.warn(`realtime subscription error on ${channel}`, event.error);
      for (const handler of errorHandlers)
        handler({ channel, code: event.error.code, message: event.error.message });
    });
    subscription.on("unsubscribed", (event) => {
      // Codes 0 and 2 are this client's own cleanup (unsubscribe called, client
      // closed); anything else is the server or a token failure dropping us.
      if (event.code === 0 || event.code === 2) return;
      console.warn(`realtime subscription unsubscribed from ${channel}`, event.code, event.reason);
      for (const handler of errorHandlers)
        handler({ channel, code: event.code, message: event.reason });
    });
    entry = { subscription, refCount: 0, publicationHandlers, subscribedHandlers, errorHandlers };
    byChannel.set(channel, entry);
    subscription.subscribe();
  }
  entry.refCount += 1;
  return entry;
}

function releaseSharedSubscription(client: Centrifuge, channel: string) {
  const byChannel = sharedSubscriptions.get(client);
  const entry = byChannel?.get(channel);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.subscription.unsubscribe();
  client.removeSubscription(entry.subscription);
  byChannel!.delete(channel);
}

export function useRealtimeSubscription({
  channel,
  getToken,
  onSubscribed,
  onPublication,
  onConnected,
  onError,
}: {
  channel?: string;
  getToken?: () => Promise<string>;
  onSubscribed?: () => void;
  onPublication: (publication: RealtimePublication) => void;
  onConnected?: () => void;
  onError?: (error: RealtimeSubscriptionError) => void;
}) {
  const client = useBrowserRealtime();
  const handlers = useRef({ channel, onSubscribed, onPublication, onConnected, onError });

  // Install the latest callbacks only after commit, so a superseded channel is
  // unsubscribed before its handlers are replaced and can never dispatch into
  // the new channel's scope.
  useEffect(() => {
    handlers.current = { channel, onSubscribed, onPublication, onConnected, onError };
  });

  useEffect(() => {
    if (!client || !channel) return;
    const current = () => (handlers.current.channel === channel ? handlers.current : undefined);
    const entry = acquireSharedSubscription(client, channel, getToken);
    const onPublicationHandler = (publication: RealtimePublication) =>
      current()?.onPublication(publication);
    const onSubscribedHandler = () => current()?.onSubscribed?.();
    const onErrorHandler = (error: RealtimeSubscriptionError) => current()?.onError?.(error);
    entry.publicationHandlers.add(onPublicationHandler);
    entry.subscribedHandlers.add(onSubscribedHandler);
    entry.errorHandlers.add(onErrorHandler);
    // A caller joining an already-subscribed shared channel missed its "subscribed" event.
    if (entry.subscription.state === "subscribed") onSubscribedHandler();
    const connected = () => current()?.onConnected?.();
    client.on("connected", connected);
    return () => {
      client.off("connected", connected);
      entry.publicationHandlers.delete(onPublicationHandler);
      entry.subscribedHandlers.delete(onSubscribedHandler);
      entry.errorHandlers.delete(onErrorHandler);
      releaseSharedSubscription(client, channel);
    };
  }, [client, channel, getToken]);
}

/**
 * Subscribes a dynamic *set* of authorized channels on the shared Workspace connection — the
 * per-Agent channels added for the viewer's own visible private Agents, one activity and
 * one status channel per Agent, whose membership changes as Agents are created, deleted or
 * change visibility. `useRealtimeSubscription` only ever manages one fixed channel; this hook is
 * its sibling for a channel list, on the same shared client, diffed by channel name so an Agent
 * leaving the set unsubscribes without disturbing the others.
 */
export function useRealtimeSubscriptions({
  channels,
  onPublication,
}: {
  channels: readonly { channel: string; getToken: () => Promise<string> }[];
  onPublication: (channel: string, publication: RealtimePublication) => void;
}) {
  const client = useBrowserRealtime();
  const onPublicationRef = useRef(onPublication);
  const tokenGetters = useRef(new Map<string, () => Promise<string>>());

  useEffect(() => {
    onPublicationRef.current = onPublication;
  });
  // Keep the latest getToken per channel without forcing a resubscribe when only its closure
  // identity changes across renders (see the channelKey-only dependency below).
  for (const { channel, getToken } of channels) tokenGetters.current.set(channel, getToken);

  const channelKey = [...new Set(channels.map((entry) => entry.channel))].sort().join("\u0000");

  useEffect(() => {
    if (!client || !channelKey) return;
    const names = channelKey.split("\u0000");
    const subscriptions = names.map((channel) => {
      const subscription = client.newSubscription(channel, {
        getToken: () => tokenGetters.current.get(channel)!(),
      });
      subscription.on("publication", (publication) =>
        onPublicationRef.current(channel, publication),
      );
      subscription.on("error", (event) => {
        console.warn(`realtime subscription error on ${channel}`, event.error);
      });
      subscription.subscribe();
      return subscription;
    });
    return () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
        client.removeSubscription(subscription);
      }
    };
  }, [client, channelKey]);
}
