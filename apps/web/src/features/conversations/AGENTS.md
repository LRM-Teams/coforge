# Conversations UI

These rules apply to `src/features/conversations/`.

- This feature does not own Agent state. Read Agent status and Activity
  through the `features/agents/` hooks, and open, close, or switch the
  right-hand Agent profile panel through
  `features/agents/profile-panel/open-agent-profile.ts` instead of writing
  `profile`/`agentTab` search params. The channel settings sheet embeds the
  profile with its own state instead (see the members page below).
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
- Direct messages list the viewer's existing DM conversations only, with
  Agents and members mixed in the order they started, as Raft does: a
  conversation starts from a "Message" affordance
  (`useOpenDirectConversation`, which opens or starts it and goes to
  `dm/<conversationId>`), never from the sidebar. Link to a DM by its
  conversation id; only a "start" affordance knows just an Agent or a member.
  Every DM row, its pin, menu actions, unread badge and read-cursor key go by
  conversation id (`dm:<conversationId>` for the cursor); only the live Agent
  activity strip looks a DM up by its Agent.
- The sidebar's channel and DM lists live in `sidebar-collections.ts` (collections and changes,
  tested without React) and `sidebar-lists.ts` (hooks). The chat layout's (`_chat`) loader fetches
  them, in the browser, into the TanStack Query cache (a later page load restores the browser's
  copy first, `../cache-persistence/`); the same keys back TanStack DB
  collections. Every channel's name (`channelNamesQuery`, for body channel links
  and the `#` list) lives in the same cache; the create-channel dialog reads projects on open.
- Realtime keeps every Chat list live, so the loader (run on each navigation inside Chat) reads
  only a list not cached or marked stale (`loadSidebarLists`); a subscribe that may have missed
  something re-reads that channel's lists (`rereadMissedBySubscribe`). Every list is read with the
  stream positions of the signal channels that keep it live, read before it
  (`readAfterStreamPositions`), and its Query data keeps them beside its rows
  (`streamPositions`; `listReadPosition` finds them), so a first subscribe re-reads a list only when
  the stream has moved past its read. A list built from two reads (the DM list) keeps the older
  position per channel (`olderStreamPositions`); a read that fell back has none. The Saved
  list's stored copy is cut to its newest entries, so it keeps none. A write that changes a list
  on this page re-reads it itself and keeps the positions. A read moves only the live badge,
  never a row, so a re-seed takes server counts only from a list read again (`unreadIdsToKeep`).
  Server and list share one order (`compareChannelNames`).
- A channel created, changed or gone in the Workspace (`channel.created.v1`, `channel.updated.v1`,
  Slack's `channel_created`/`channel_rename`) carries its info or `gone`, which
  `applyChannelSignalToLists` writes into the names and the list without a read; it re-reads only
  what an event cannot place, and a list being read or while a sidebar change is saving (a failed
  save's rollback undoes a direct write made meanwhile).
- Read the lists with `useSidebarLists` and change them only through `useSidebarActions`
  (optimistic; a saved change is written into the synced list, a failed save rolls it back); never
  `router.invalidate` for a sidebar change. A message that brings a closed or unlisted chat in
  re-reads only its own list (`closedConversationLists`), plus the Agent roster for a new Agent
  (`unknownAgentOf`). A change made outside the sidebar on this page (a channel's creation, rename
  or archive, or leaving, muting or pinning it from the settings panel) re-reads the channel list
  through `useRefreshSidebarChannels`. The viewer's own changes elsewhere arrive as a `ViewerEvent`
  on their `chat:user:` channel (Slack's `channel_marked`, `channel_joined`, `im_marked`,
  `im_created`, `pref_change`, `star_added`, `star_removed`): a read sets the badge from the
  event's count; any other re-reads only the lists `sidebarListsChangedBy` names. A message signal
  names the person who wrote it (`senderUserId`, Slack's `message.user`); the viewer's own message
  never bumps their badge or brings a closed chat back.
- A message row's Task, thread and Agent status data is read by the part that
  shows it, by id, as Mattermost and Telegram Web do. An Agent's avatar
  (`MessageAgentAvatar`) reads its one Agent through `useLiveAgentDisplay`. The Task a message became
  (`MessageTask`) and a body's task reference (`TaskReference`) each read one
  Task under `ConversationIdProvider` (see `features/tasks/AGENTS.md`). A
  root's thread preview and thread entries (`thread-summary.tsx`) read that
  root from the conversation's TanStack Store thread store
  (`thread-store.tsx`, `useSelector`), which `ThreadedConversation` creates
  and keeps in step; a pane given `onOpenThread` must sit under its
  `ThreadStoreProvider`.
  Never pass rows a render callback or a value built from the conversation's
  Tasks, threads or live Agents: a change to one would re-render every row.
- A window holds top-level messages, each thread as a summary (`threads`); a thread's replies
  are read when its pane opens (`thread-queries.ts`), and what arrives later goes through
  `thread-cache.ts`. Index, around-window and thread reads share one Server Function seam.
- A message a server function returns holds JSON-compatible values only (a time
  is an ISO string, as `mapBrowserMessage` gives it): TanStack Query's structural
  sharing then keeps each unchanged message's object across a re-read (focus,
  remount, invalidation, reconcile). A `Date` or class instance makes every
  message new on every re-read, and every row renders and parses again.
- Chat is rendered in the browser only, as Slack's page is: the `_chat` route is `ssr: false`
  (every route under it inherits that), so the server sends the app's chrome and `MessagesPending`
  (a loading screen: the list column, the conversation and its composer as skeletons), and the
  sidebar's lists, the open conversation and Saved are read by loaders that run in the browser.
  No loader under `_chat` reads them on the server. A host the server does render that shows a
  conversation mounts it under `ClientOnly`: the search preview, whose loader reads it with
  `loadConversationPage` (which does nothing on the server), and the Tasks page's Task popup
  (`OverviewTaskPopup`), which reads it through `useChannelConversation`. So a row needs no
  cookie, assumed value or `suppressHydrationWarning` to match server markup, and a conversation
  may read browser-only sources at render (TanStack DB collections, `localStorage`, the viewport).
  - A message time is formatted in the zone `useTimeZone()` gives (the viewer's saved zone, else
    the browser's): pass it to `dayLabel` and `clockLabel`, never omit it.
  - The rail and the loading screen are server-rendered, and a structure that differs between a
    phone and a desktop is chosen by `useBreakpoint`/`useCoarsePointer`, which start from what
    the request says (`requestIsFromPhone`), never by a `matchMedia` read into state.
- TanStack DB collections are client-only: create them through the
  per-`QueryClient` factory, never at module scope. The Tasks, Saved and sidebar factories call
  `assertBrowserOnly` (`lib/browser-only.ts`, Vite's `import.meta.env.SSR`), so one reached while
  the server renders fails loudly; a new factory does the same.
- Direct and channel views share the empty-state layout and compact thread
  prompt in `conversation-pane.tsx`. Each supplies its own identity and copy
  and keeps its composer or join action; both kinds of DM take their
  empty-state avatar and `@name` thread context from
  `direct-threaded-conversation.tsx`.
- DM and channel headers fill the shared `components/layout/tabbed-header.tsx`
  row (identity, centered Chat/Tasks/Files tabs, actions); give it slots rather
  than laying out a second tab row. Its tabs come from
  `conversationHeaderTabs` (`conversation-header-tabs.tsx`).
- The main stream's side room (and its "Full-width messages" device setting)
  is `MESSAGE_COLUMN_CLASS` in `features/settings/message-width.ts`; history
  and composer both use it so they line up. Do not add a second width rule.
- `direct-threaded-conversation.tsx` is what both kinds of DM share around the
  stream (named `@<name>`, the other side's avatar on the empty state);
  `direct-conversation.tsx` is the Agent DM wrapper and header;
  `people-direct-conversation.tsx` is the DM between members (a member's DM with
  themself included): always writable, no Agent in it, and its composer offers no
  @-completion because the server keeps a mention there as plain text. `threaded-conversation.tsx`
  coordinates thread/profile panes; `conversation-pane.tsx` renders one message
  stream; `use-conversation-sync.ts` owns browser-only deep-link and read-cursor
  synchronization.
- `conversation-host.tsx` is what a conversation reads from the page hosting
  it (Chat, the search preview): the viewer's open mode, the Workspace's
  channels and the Saved list. A host's loader reads `savedMessagesQuery` into
  the Query cache, which the store starts from. Once hydrated
  the list is a TanStack DB collection (`saved-messages-collection.ts`) on the
  app's one `DbClient` (`DbProvider` in `router.tsx`, read with `useDbClient`),
  shared by every host; it starts from that cache and follows it. TanStack DB's
  GC empties it (and removes its Query) once no page shows it; a host's loader reads
  the list when the cache lacks it or it is marked stale, and the store stands back on that until the
  collection has synced. Never materialize a
  collection during a server render. The sidebar's unread badges stay Chat's own. Read it through
  `useSavedEntries`/`useIsMessageSaved` and write through the context's
  `save`/`unsave`; never a module-level collection or `createCollection`
  singleton, which would share state across SSR requests.
- A conversation's data and actions (messages kept live, its Tasks, send,
  react, join, read and follow threads) come from `useChannelConversation` /
  `useDirectConversation` (`use-conversation-data.ts`), shared by the
  conversation pages and the Tasks page popup. Change a send or read path
  there, not in a route.
- `conversation-page.tsx` (`ConversationPage`) is a conversation as Chat
  opens it (tabs, Task board, files, reading), one page for channels and
  direct messages: each kind supplies only its data, header, conversation and
  read cursor, and both kinds of DM share one read cursor (`dm:<conversationId>`),
  so a DM kind supplies only its name, header and conversation. The Chat
  routes and the search preview both render it, so the two never differ;
  a host only reads its params and loads through `loadConversationPage`
  (`conversation-page-loader.ts`). Their address state is
  `conversationPageSearchShape`, which every host's `validateSearch` spreads.
- `mentionOutsiders` (the channel's people and public Agents outside it) is for
  @-completion only. Never merge it into `mentionables`, which also resolves
  plain `@handle` labels and stored mention tokens.
- The live Agent activity strip shows one notable display (working, thinking,
  or error; newest cloud revision). Idle and offline stay in the directory.
- A channel's members are a page of its settings panel
  (`channel-members-page.tsx`): the Members summary opens the roster and its
  "+" the add view, both in place of the settings, with Back. An Agent row
  opens that Agent's profile inside the sheet too, and its Back returns to the
  roster with its search kept and focus on that row. The page and the
  panel's Members strip read one `channelMembersQueryKey` query; a write
  updates or invalidates it rather than keeping its own copy. Removing a
  member confirms in a dialog: no toast, no browser `confirm()`. The add
  view's last row creates a public Agent (for a Workspace owner or admin, per
  the server's `canCreateAgents`) and then adds it. A join that fails offers
  a retry and disables the entry, so the Agent is not created twice.
- The header gear opens `channel-settings-panel.tsx`, the one place for a
  channel's info (name, description), the viewer's preferences (pin, mute,
  collapse long messages: `ConversationMember.collapseLongMessages`, on by
  default, read by every pane of the conversation, thread panes included)
  and its actions (archive, leave, stopping every Agent in it and resuming
  them with new guidance for any member of a live channel; hiding `#general`
  or deleting the channel for a Workspace owner or admin); each action
  confirms in a dialog, whose confirm button is red only for a permanent
  action (delete). Hiding `#general` and the way back (the System channels
  section of Settings → Members) are for a Workspace owner or admin only; the
  server decides who that is, the client never re-derives it from a role.
- A conversation that answers `NOT_FOUND` (such as a channel just hidden from
  the Workspace or deleted) leaves for Chat through `ConversationLoadError`; do not show
  it as a load failure.
- Leaving a channel reuses the never-joined read-only conversation state and
  `joined: false` in the channel list. Do not add a separate "left" state.
- A human commits an action card through the existing `CreateChannelDialog`,
  `AgentCreateDialog`, or `ChannelMembersDialog` (used only for this) with
  their preselect/commit props. Do not build card-specific creation forms.
- The browser refreshes only the pending action cards it shows, through
  `loadActionCardStates` on the `messageAvailable` signal and on window focus.
