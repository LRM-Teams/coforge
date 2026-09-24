# Conversations UI

These rules apply to `src/features/conversations/`.

- This feature does not own Agent state. Read Agent status and Activity
  through the `features/agents/` hooks, and open, close, or switch the Agent
  profile panel through `features/agents/profile-panel/open-agent-profile.ts`
  instead of writing `profile`/`agentTab` search params.
- `conversation-navigation.tsx` owns Chat list/detail selection, retained
  list scroll, and mounted conversation drafts on desktop and mobile. At `lg`
  and above, list and detail stay side by side; narrower viewports switch
  between them. Neither sidebar renders conversation lists or their creation
  actions. `last-conversation.ts` owns which conversation Chat opens on a desktop
  (the remembered one while listed, else the first joined channel);
  `conversation-layout.tsx` only navigates there.
- A pinned channel or DM appears only in the sidebar's Pinned section, which
  `pinned-conversations.ts` builds by merging both kinds by pin order; closing
  a chat never takes it out of Pinned. A row can be dragged into Pinned or
  back to its own section only. A drag saves the new pin order plus the rows
  it unpinned, never a whole list, so pins it cannot see survive.
  Channels and Direct messages are not reordered by hand.
- The sidebar's channel and DM lists live in `sidebar-collections.ts`
  (collections and changes, tested without React) and `sidebar-lists.ts`
  (hooks): the `/messages` loader fetches them into the TanStack Query cache
  (the server render reads it), and after hydration the same Query keys back
  TanStack DB collections. Read them with `useSidebarLists` and change them
  only through `useSidebarActions` (optimistic: the row changes at once, a
  saved change is written into the synced list, a failed save rolls it back);
  never `router.invalidate` for a sidebar change. A change made
  outside the sidebar (a channel's rename or archive, here or signalled by
  `channel.updated.v1`, or the viewer leaving, muting or pinning it from the
  settings panel) re-reads only the
  channel list through `useRefreshSidebarChannels`.
- TanStack DB collections are client-only: create them through the
  per-`QueryClient` factory after hydration, never at module scope, and keep
  `/messages` server-rendered.
- Direct and channel views share the empty-state layout and compact thread
  prompt in `direct-conversation.tsx`. Each supplies its own identity, media,
  and copy, and keeps its composer or join action.
- `conversation-header.tsx` is the one header row both DM and channel headers
  fill (identity, centered Chat/Tasks/Files tabs, actions); give it slots rather
  than laying out a second tab row.
- The main stream's side room (and its "Full-width messages" device setting)
  is `MESSAGE_COLUMN_CLASS` in `features/settings/message-width.ts`; history
  and composer both use it so they line up. Do not add a second width rule.
- `direct-conversation.tsx` is the DM wrapper and header; `threaded-conversation.tsx`
  coordinates thread/profile panes; `conversation-pane.tsx` renders one message
  stream; `use-conversation-sync.ts` owns browser-only deep-link and read-cursor
  synchronization.
- The Saved list is a TanStack DB collection (`saved-messages-collection.ts`) on the
  Chat layout's `DbClient`, seeded from the loader. Read it through
  `useSavedEntries`/`useIsMessageSaved` and write through the context's
  `save`/`unsave`; never a module-level collection or `createCollection`
  singleton, which would share state across SSR requests.
- A conversation's data and actions (messages kept live, its Tasks, send,
  react, join, read and follow threads) come from `useChannelConversation` /
  `useDirectConversation` (`use-conversation-data.ts`), shared by the
  conversation routes and the Tasks page popup. Change a send or read path
  there, not in a route.
- Message index and around-window reads go through this feature's shared
  Server Function seam, scoped by `conversationId` for both direct
  conversations and channels.
- The live Agent activity strip shows one notable display (working, thinking,
  or error; newest cloud revision). Idle and offline stay in the directory.
- Destructive actions in the channel members dialog use an inline confirm
  step: no toast, no browser `confirm()`.
- The header gear opens `channel-settings-panel.tsx`, the one place for a
  channel's info (name, description), the viewer's preferences (pin, mute)
  and its actions (archive, leave); each action confirms in a dialog. The
  members dialog only manages members.
- Leaving a channel reuses the never-joined read-only conversation state and
  `joined: false` in the channel list. Do not add a separate "left" state.
- A human commits an action card through the existing `CreateChannelDialog`,
  `AgentCreateDialog`, or `ChannelMembersDialog` with their preselect/commit
  props. Do not build card-specific creation forms.
- The browser refreshes only the pending action cards it shows, through
  `loadActionCardStates` on the `messageAvailable` signal and on window focus.
