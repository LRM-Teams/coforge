# Browser realtime

These rules apply to `src/features/realtime/`.

- The Workspace layout (`w.$workspaceSlug.tsx`) owns one Centrifuge
  connection for the Workspace the page URL names. Feature modules may subscribe to authorized channels but must not
  create additional browser WebSocket connections.
- Subscribe through `useRealtimeSubscription` from `browser-realtime.tsx`; it
  owns the client type. A channel with a narrower server-issued grant supplies
  its own subscription token to the hook.
- Subscription hooks must run below `BrowserRealtimeProvider`. Do not call one
  in the component that renders the provider; `useBrowserRealtime` throws there
  so the mistake fails at first render instead of silently never subscribing.
- `useRealtimeSubscription` ref-counts one real `Subscription` per channel per
  client, so several features may share a channel (for example
  `chat:user:<user_id>`). Never call `newSubscription` directly; Centrifuge
  rejects a second subscription to the same channel.
- Presence and join/leave exist only in the `presence` Centrifugo namespace; do
  not enable them on another namespace to answer "who is online".
