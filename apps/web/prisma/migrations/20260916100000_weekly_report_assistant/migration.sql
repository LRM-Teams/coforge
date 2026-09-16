CREATE TABLE "weekly_report_assistants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_assistants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_report_assistants_agentId_key"
    ON "weekly_report_assistants"("agentId");
CREATE UNIQUE INDEX "weekly_report_assistants_agentId_workspaceId_key"
    ON "weekly_report_assistants"("agentId", "workspaceId");
CREATE UNIQUE INDEX "weekly_report_assistants_workspaceId_userId_key"
    ON "weekly_report_assistants"("workspaceId", "userId");
CREATE INDEX "weekly_report_assistants_workspaceId_idx"
    ON "weekly_report_assistants"("workspaceId");
CREATE INDEX "weekly_report_assistants_userId_idx"
    ON "weekly_report_assistants"("userId");

ALTER TABLE "weekly_report_assistants"
    ADD CONSTRAINT "weekly_report_assistants_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_assistants"
    ADD CONSTRAINT "weekly_report_assistants_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_assistants"
    ADD CONSTRAINT "weekly_report_assistants_agentId_workspaceId_fkey"
    FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;
