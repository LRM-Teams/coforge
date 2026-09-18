-- Multica-style weekly-report side-chat sessions scoped to a page subject.
CREATE TABLE "weekly_report_assistant_chat_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_assistant_chat_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "weekly_report_assistant_chat_sessions_workspaceId_userId_subjectType_subjectId_updatedAt_idx"
  ON "weekly_report_assistant_chat_sessions"("workspaceId", "userId", "subjectType", "subjectId", "updatedAt");

CREATE INDEX "weekly_report_assistant_chat_sessions_workspaceId_userId_idx"
  ON "weekly_report_assistant_chat_sessions"("workspaceId", "userId");

ALTER TABLE "weekly_report_assistant_chat_sessions"
  ADD CONSTRAINT "weekly_report_assistant_chat_sessions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_report_assistant_chat_sessions"
  ADD CONSTRAINT "weekly_report_assistant_chat_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "record_comments"
  ADD COLUMN "assistantSessionId" UUID;

CREATE INDEX "record_comments_assistantSessionId_idx"
  ON "record_comments"("assistantSessionId");

ALTER TABLE "record_comments"
  ADD CONSTRAINT "record_comments_assistantSessionId_fkey"
  FOREIGN KEY ("assistantSessionId") REFERENCES "weekly_report_assistant_chat_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
