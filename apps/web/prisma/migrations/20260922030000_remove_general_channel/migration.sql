-- Remove the built-in #general channel. New Workspaces and members no longer auto-create or
-- auto-join it; this migration deletes existing #general channels and their channel-scoped data.

DELETE FROM "reminders"
WHERE "target" = '#general' OR "target" LIKE '#general:%';

DELETE FROM "task_history_events" AS the
USING "tasks" AS task, "conversations" AS conversation
WHERE the."taskMessageId" = task."messageId"
  AND task."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "tasks" AS task
USING "conversations" AS conversation
WHERE task."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "action_cards" AS card
USING "conversations" AS conversation
WHERE card."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "thread_reads" AS tr
USING "conversations" AS conversation
WHERE tr."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "thread_follows" AS tf
USING "conversations" AS conversation
WHERE tf."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "message_mentions" AS mention
USING "conversations" AS conversation
WHERE mention."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "message_reactions" AS reaction
USING "conversations" AS conversation
WHERE reaction."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "agent_message_deliveries" AS delivery
USING "conversations" AS conversation
WHERE delivery."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "messages" AS msg
USING "conversations" AS conversation
WHERE msg."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "conversation_members" AS member
USING "conversations" AS conversation
WHERE member."conversationId" = conversation."id"
  AND conversation."channelName" = 'general';

DELETE FROM "conversations"
WHERE "channelName" = 'general';
