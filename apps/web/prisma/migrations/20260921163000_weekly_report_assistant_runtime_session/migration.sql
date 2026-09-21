-- One WeeklyReportAssistant Agent session reservation per Records page subject (ADR 0059).
CREATE TABLE "weekly_report_assistant_runtime_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_asst_runtime_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_report_asst_runtime_subject_key"
  ON "weekly_report_assistant_runtime_sessions"("workspaceId", "agentId", "subjectType", "subjectId");

CREATE INDEX "weekly_report_asst_runtime_agent_idx"
  ON "weekly_report_assistant_runtime_sessions"("workspaceId", "agentId");

ALTER TABLE "weekly_report_assistant_runtime_sessions"
  ADD CONSTRAINT "weekly_report_asst_runtime_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_report_assistant_runtime_sessions"
  ADD CONSTRAINT "weekly_report_asst_runtime_agent_fkey"
  FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
