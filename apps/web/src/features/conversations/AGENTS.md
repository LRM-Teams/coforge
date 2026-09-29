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
- The sidebar's channel and DM lists live in `sidebar-collections.ts`
  (collections and changes, tested without React) and `sidebar-lists.ts`
  (hooks): the chat layout's (`_chat`) loader fetches them into the TanStack Query cache
  (the server render reads it), and after hydration the same Query keys back
  TanStack DB collections. Every channel's name (`channelNamesQuery`, for body channel links
  and the `#` list) lives in the same cache; the create-channel dialog reads projects when it
  opens. A channel created, changed or gone anywhere in the Workspace (`channel.created.v1`,
  `channel.updated.v1`, Slack's `channel_created` and `channel_rename`) carries the channel's
  info or `gone`, and `useApplyChannelSignal` writes it into the names and the channel list
  (`channel-signals.ts`, `applyChannelSignalToLists`) without a read. It re-reads instead what
  an event cannot place, and a list while it is being read or a sidebar change is being saved
  (a failed save's rollback undoes a direct write made meanwhile). The server and the list share one order (`compareChannelNames`). Read the lists
  with `useSidebarLists` and change them
  only through `useSidebarActions` (optimistic: the row changes at once, a
  saved change is written into the synced list, a failed save rolls it back);
  never `router.invalidate` for a sidebar change; a message that brings a
  closed or unlisted chat in re-reads only its own list
  (`closedConversationLists`), plus the Agent roster when the Agent is new to
  it (`unknownAgentOf`). A change made
  outside the sidebar on this page (a channel's creation, rename or archive, or the viewer
  leaving, muting or pinning it from the settings panel) re-reads only the
  channel list through `useRefreshSidebarChannels`. The viewer's own changes made on another
  page, tab or device arrive as a `ViewerEvent` on their `chat:user:` channel (Slack's
  `channel_marked`, `channel_joined`, `im_marked`, `im_created`, `pref_change`, `star_added`, `star_removed`): a read sets the badge from the event's
  count, and any other re-reads only the lists `sidebarListsChangedBy` names (a save or unsave, only the Saved list).
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
- A message a server function returns holds JSON-compatible values only (a time
  is an ISO string, as `mapBrowserMessage` gives it): TanStack Query's structural
  sharing then keeps each unchanged message's object across a re-read (focus,
  remount, invalidation, reconcile). A `Date` or class instance makes every
  message new on every re-read, and every row renders and parses again.
- The chat pages render their messages on the server, so rows are in the
  first paint and hydration renders each of them once. Do not put a
  conversation behind `ClientOnly` again; what needs the browser is narrow:
  `ConversationTaskDemand`, the Tasks tab, and the Task popup shown alone on
  the Tasks page. Whatever a row reads must give the server render, the
  hydrating render and the first browser render the same answer, or the row
  renders again after hydration (a state, context or store that changes at
  hydration re-renders every row; a different element structure remounts the
  pane). So:
  - Times use the viewer's zone from `useTimeZone()` (the saved preference,
    else the browser's, which the browser writes in the `coforge-time-zone`
    cookie), the URL's locale and the 12/24-hour preference; never the host's
    zone, `useHydrated()` or `Date.now()`. The zone is unknown on a browser's
    first visit only, and the rows then show the UTC date until it reports.
  - Viewport and pointer come from `useBreakpoint`/`useCoarsePointer`; the
    server render assumes a phone or a desktop from the request
    (`requestIsFromPhone`), so a structure that differs between them must be
    chosen by these hooks, never by a `matchMedia` read into state.
  - The panel layout is a cookie (`panel-layout-cookie.ts`), not
    `localStorage`, so the server renders the saved sizes: the `_chat` loader
    reads it (`loadPanelLayouts`), `useDefaultLayout` reads it through
    `usePanelLayoutStorage`. This is `react-resizable-panels`' documented
    server-rendering setup; do not fall back to `localStorage`.
  - A part that reads a client-only source (Tasks, the Saved collection, an
    `<img>` that settled before hydration, a PDF's page origin) renders what
    the server rendered first and its own answer after: `useHydrated()`,
    `switchableSavedMessagesStore`, the ref check in `AttachmentCard`,
    `useAttachmentPreviewKind`. Only that part renders again.
  - `PinToLatestOnFirstPaint` scrolls the history to its end as the page
    parses, so the first paint shows the newest messages.
- TanStack DB collections are client-only: create them through the
  per-`QueryClient` factory after hydration, never at module scope or while
  rendering on the server.
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
  the Query cache, which the server and hydrating render read. After hydration
  the list is a TanStack DB collection (`saved-messages-collection.ts`) on the
  app's one `DbClient` (`DbProvider` in `router.tsx`, read with `useDbClient`),
  shared by every host; it starts from that cache and follows it. TanStack DB's
  GC empties it (and its Query) once no page shows it; a host's loader reads
  the list again on every visit, and the store stands back on that until the
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
- Message index and around-window reads go through this feature's shared
  Server Function seam, scoped by `conversationId` for both direct
  conversations and channels.
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
