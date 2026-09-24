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
  a chat never takes it out of Pinned. The drop rules live in
  `moveInDirectory`, and a drag commits the whole pin list through
  `replacePinnedConversations`. Channels and Direct messages are not
  reordered by hand.
- Direct and channel views share the empty-state layout and compact thread
  prompt in `direct-conversation.tsx`. Each supplies its own identity, media,
  and copy, and keeps its composer or join action.
- Message index and around-window reads go through this feature's shared
  Server Function seam, scoped by `conversationId` for both direct
  conversations and channels.
- The live Agent activity strip shows one notable display (working, thinking,
  or error; newest cloud revision). Idle and offline stay in the directory.
- Destructive actions in the channel members dialog use an inline confirm
  step: no toast, no browser `confirm()`.
- Leaving a channel reuses the never-joined read-only conversation state and
  `joined: false` in the channel list. Do not add a separate "left" state.
- A human commits an action card through the existing `CreateChannelDialog`,
  `AgentCreateDialog`, or `ChannelMembersDialog` with their preselect/commit
  props. Do not build card-specific creation forms.
- The browser refreshes only the pending action cards it shows, through
  `loadActionCardStates` on the `messageAvailable` signal and on window focus.
