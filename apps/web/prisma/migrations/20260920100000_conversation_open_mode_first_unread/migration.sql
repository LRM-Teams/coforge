-- Open a conversation where the viewer left off. Slack offers the same three choices under
-- "When I view a channel", and both Slack and Discord land on the unread boundary rather than
-- on the newest message, which is what makes the unread divider something you arrive at.
-- The column shipped two days ago (20260918193000) carrying the previous fixed behavior as its
-- default, so a row still holding 'newest-read' is holding that default, not a user's choice.
ALTER TABLE "users" ALTER COLUMN "conversationOpenMode" SET DEFAULT 'first-unread';

UPDATE "users" SET "conversationOpenMode" = 'first-unread' WHERE "conversationOpenMode" = 'newest-read';
