-- Slack-style "When I view a channel" preference (ADR 0046 follow-up).
-- newest-read: open at the newest message and mark read (previous fixed behavior).
-- first-unread: open at the oldest unread message.
-- newest-unread: open at the newest but keep unseen messages unread until scrolled through.
ALTER TABLE "users" ADD COLUMN     "conversationOpenMode" TEXT NOT NULL DEFAULT 'newest-read';