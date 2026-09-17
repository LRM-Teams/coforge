-- ADR 0032: weekly-report collector bindings, Collect Runs, and per-Computer slots.

CREATE TABLE "weekly_report_collector_bindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "collectorAgentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_collector_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_report_collector_bindings_collectorAgentId_key"
    ON "weekly_report_collector_bindings"("collectorAgentId");
CREATE UNIQUE INDEX "weekly_report_collector_bindings_collectorAgentId_workspaceId_key"
    ON "weekly_report_collector_bindings"("collectorAgentId", "workspaceId");
CREATE UNIQUE INDEX "weekly_report_collector_bindings_workspaceId_userId_computerId_key"
    ON "weekly_report_collector_bindings"("workspaceId", "userId", "computerId");
CREATE INDEX "weekly_report_collector_bindings_workspaceId_idx"
    ON "weekly_report_collector_bindings"("workspaceId");
CREATE INDEX "weekly_report_collector_bindings_userId_idx"
    ON "weekly_report_collector_bindings"("userId");
CREATE INDEX "weekly_report_collector_bindings_computerId_idx"
    ON "weekly_report_collector_bindings"("computerId");

ALTER TABLE "weekly_report_collector_bindings"
    ADD CONSTRAINT "weekly_report_collector_bindings_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_collector_bindings"
    ADD CONSTRAINT "weekly_report_collector_bindings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_collector_bindings"
    ADD CONSTRAINT "weekly_report_collector_bindings_computerId_fkey"
    FOREIGN KEY ("computerId") REFERENCES "computers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_collector_bindings"
    ADD CONSTRAINT "weekly_report_collector_bindings_collectorAgentId_workspaceId_fkey"
    FOREIGN KEY ("collectorAgentId", "workspaceId") REFERENCES "agents"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "weekly_report_collect_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "windowKind" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_collect_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "weekly_report_collect_runs_workspaceId_userId_reportId_idx"
    ON "weekly_report_collect_runs"("workspaceId", "userId", "reportId");
CREATE INDEX "weekly_report_collect_runs_reportId_createdAt_idx"
    ON "weekly_report_collect_runs"("reportId", "createdAt");

ALTER TABLE "weekly_report_collect_runs"
    ADD CONSTRAINT "weekly_report_collect_runs_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_collect_runs"
    ADD CONSTRAINT "weekly_report_collect_runs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_collect_runs"
    ADD CONSTRAINT "weekly_report_collect_runs_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "weekly_reports"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "weekly_report_collect_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "collectorAgentId" UUID NOT NULL,
    "scanPaths" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "packMarkdown" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_collect_slots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_report_collect_slots_requestId_key"
    ON "weekly_report_collect_slots"("requestId");
CREATE UNIQUE INDEX "weekly_report_collect_slots_runId_computerId_key"
    ON "weekly_report_collect_slots"("runId", "computerId");
CREATE INDEX "weekly_report_collect_slots_runId_idx"
    ON "weekly_report_collect_slots"("runId");
CREATE INDEX "weekly_report_collect_slots_computerId_idx"
    ON "weekly_report_collect_slots"("computerId");

ALTER TABLE "weekly_report_collect_slots"
    ADD CONSTRAINT "weekly_report_collect_slots_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "weekly_report_collect_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_collect_slots"
    ADD CONSTRAINT "weekly_report_collect_slots_computerId_fkey"
    FOREIGN KEY ("computerId") REFERENCES "computers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
