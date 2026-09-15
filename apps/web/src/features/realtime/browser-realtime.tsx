import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Centrifuge, type Subscription } from "centrifuge/build/protobuf";

/** The one realtime subscription type for the shared Workspace connection. */
export type BrowserRealtimeSubscription = Subscription;

const BrowserRealtimeContext = createContext<Centrifuge | null>(null);

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
  return useContext(BrowserRealtimeContext);
}

export type RealtimePublication = { channel: string; data: unknown };

/**
 * Subscribes one authorized channel on the shared Workspace connection.
 *
 * The `_app` layout owns the only browser connection; features subscribe
 * through this hook and never construct their own Centrifuge client. A channel
 * with a narrower server-issued grant supplies its own `getToken`.
 */
export function useRealtimeSubscription({
  channel,
  getToken,
  onSubscribed,
  onPublication,
  onConnected,
}: {
  channel?: string;
  getToken?: () => Promise<string>;
  onSubscribed?: () => void;
  onPublication: (publication: RealtimePublication) => void;
  onConnected?: () => void;
}) {
  const client = useBrowserRealtime();
  const handlers = useRef({ channel, onSubscribed, onPublication, onConnected });

  // Install the latest callbacks only after commit, so a superseded channel is
  // unsubscribed before its handlers are replaced and can never dispatch into
  // the new channel's scope.
  useEffect(() => {
    handlers.current = { channel, onSubscribed, onPublication, onConnected };
  });

  useEffect(() => {
    if (!client || !channel) return;
    const current = () => (handlers.current.channel === channel ? handlers.current : undefined);
    const subscription = client.newSubscription(channel, getToken ? { getToken } : undefined);
    subscription.on("subscribed", () => current()?.onSubscribed?.());
    subscription.on("publication", (publication) => current()?.onPublication(publication));
    const connected = () => current()?.onConnected?.();
    client.on("connected", connected);
    subscription.subscribe();
    return () => {
      client.off("connected", connected);
      subscription.unsubscribe();
      client.removeSubscription(subscription);
    };
  }, [client, channel, getToken]);
}
