-- Retire the built-in #general channel without deleting user work. New Workspaces and members no
-- longer auto-create or auto-join it; this migration archives any legacy #general channel so it is
-- read-only/hidden by normal navigation while preserving messages, Tasks, Action cards, attachments,
-- deliveries, and reminder targets for audit/history.

UPDATE "conversations"
SET "archivedAt" = COALESCE("archivedAt", now())
WHERE "channelName" = 'general';
