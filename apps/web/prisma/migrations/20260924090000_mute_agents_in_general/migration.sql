-- Every Agent in #general is muted (Frank, 2026-09-24): ordinary #general chatter would otherwise
-- wake every public Agent in the Workspace. A personal @mention still reaches a muted Agent, and an
-- Agent may unmute itself. 20260924040000_restore_general_channel enrolled Agents unmuted; this
-- corrects those rows, and also re-mutes an Agent that had unmuted #general itself (before #general
-- was retired, or in the minutes since the restore); it can unmute again. Humans are untouched.
-- Safe to run more than once.

UPDATE "conversation_members" cm
SET "channelMuted" = TRUE
FROM "conversations" c
WHERE cm."conversationId" = c."id"
  AND c."channelName" = 'general'
  AND cm."agentId" IS NOT NULL
  AND cm."channelMuted" = FALSE;
