import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  useBrowserRealtime,
  useRealtimeSubscription,
  type RealtimeClient,
} from "#src/features/realtime/browser-realtime";
import { getWorkspacePresenceSubscriptionToken } from "#src/features/realtime/realtime.functions";
import { workspacePresenceChannel } from "./presence-channel";

/**
 * Which Workspace members are online: a member is online while at least one of their browser
 * connections is subscribed to the Workspace presence channel. Built from one presence read per
 * (re)subscribe, then kept current by join and leave.
 */
export class WorkspacePresence {
  /** Connection (Centrifugo client id) → the user it belongs to. */
  private clients = new Map<string, string>();
  private online = new Set<string>();
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  /** The latest read, and the joins and leaves heard while it is in flight (`null`: none is). */
  private read = 0;
  private sinceRead: { joined: boolean; info: RealtimeClient }[] | null = null;

  /** `undefined` until the first presence read: an unknown state is never drawn as offline. */
  isOnline(userId: string): boolean | undefined {
    return this.loaded ? this.online.has(userId) : undefined;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /**
   * Starts a full presence read; call the result with what the server returned. The read replaces
   * everything, including joins and leaves missed while disconnected, and then replays the ones
   * heard while it was in flight, which the server's snapshot may predate. A read overtaken by a
   * newer one is ignored; a failed read (`undefined`) keeps the last known state.
   */
  beginRead() {
    const read = ++this.read;
    this.sinceRead = [];
    return (clients: Record<string, RealtimeClient> | undefined) => {
      if (read !== this.read) return;
      const heard = this.sinceRead ?? [];
      this.sinceRead = null;
      if (!clients) return;
      this.clients = new Map(Object.values(clients).map((info) => [info.client, info.user]));
      for (const { joined, info } of heard) this.apply(joined, info);
      this.loaded = true;
      this.refresh();
    };
  }

  join(info: RealtimeClient) {
    this.sinceRead?.push({ joined: true, info });
    this.apply(true, info);
    this.refresh();
  }

  leave(info: RealtimeClient) {
    this.sinceRead?.push({ joined: false, info });
    this.apply(false, info);
    this.refresh();
  }

  private apply(joined: boolean, info: RealtimeClient) {
    if (joined) this.clients.set(info.client, info.user);
    else this.clients.delete(info.client);
  }

  private refresh() {
    this.online = new Set(this.clients.values());
    if (this.loaded) for (const listener of this.listeners) listener();
  }
}

const WorkspacePresenceContext = createContext<WorkspacePresence | undefined>(undefined);

/**
 * Owns the app shell's one presence subscription, so every open CoForge tab counts its user as
 * online wherever they are in the app. Must be rendered inside `BrowserRealtimeProvider`.
 */
export function WorkspacePresenceProvider({
  workspaceId,
  children,
}: {
  workspaceId?: string;
  children: ReactNode;
}) {
  // One store per Workspace: switching Workspace starts from "unknown", never from the old list
  // (React's "adjusting state when a prop changes").
  const [store, setStore] = useState(() => ({ workspaceId, presence: new WorkspacePresence() }));
  if (store.workspaceId !== workspaceId)
    setStore({ workspaceId, presence: new WorkspacePresence() });
  const { presence } = store;
  const client = useBrowserRealtime();
  const getToken = useServerFn(getWorkspacePresenceSubscriptionToken);
  const channel = workspaceId ? workspacePresenceChannel(workspaceId) : undefined;
  // `onSubscribed` also fires after every resubscribe, which is when a disconnect may have
  // hidden joins and leaves.
  useRealtimeSubscription({
    channel,
    getToken,
    onSubscribed: () => {
      if (!client || !channel) return;
      // A failed read keeps the last known state; the next resubscribe reads again.
      const finish = presence.beginRead();
      client.presence(channel).then(
        (result) => finish(result.clients),
        (error: unknown) => {
          finish(undefined);
          console.warn(`realtime presence read failed on ${channel}`, error);
        },
      );
    },
    onJoin: (info) => presence.join(info),
    onLeave: (info) => presence.leave(info),
  });

  return (
    <WorkspacePresenceContext.Provider value={presence}>
      {children}
    </WorkspacePresenceContext.Provider>
  );
}

/** Whether a Workspace member is online; `undefined` while presence is still loading. */
export function useMemberOnline(userId: string): boolean | undefined {
  const presence = useContext(WorkspacePresenceContext);
  if (!presence) throw new Error("useMemberOnline must be called inside WorkspacePresenceProvider");
  return useSyncExternalStore(
    presence.subscribe,
    () => presence.isOnline(userId),
    () => undefined,
  );
}
