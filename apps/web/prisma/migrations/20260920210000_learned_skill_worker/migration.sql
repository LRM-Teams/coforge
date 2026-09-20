-- Worker substrate (ADR 0052, slices 2-3): per-Workspace model configuration
-- for the distill→propose sweep chain, daily call-usage counters, and one
-- distillation-run row per cadence pass (critique | merge | propose).

CREATE TABLE "workspace_model_configurations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL DEFAULT '',
    "apiKey" JSONB,
    "dailyBudget" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workspace_model_configurations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_model_configurations_workspaceId_key"
    ON "workspace_model_configurations"("workspaceId");
ALTER TABLE "workspace_model_configurations"
    ADD CONSTRAINT "workspace_model_configurations_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workspace_model_usages" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workspace_model_usages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_model_usages_workspaceId_purpose_day_key"
    ON "workspace_model_usages"("workspaceId", "purpose", "day");
CREATE INDEX "workspace_model_usages_workspaceId_idx"
    ON "workspace_model_usages"("workspaceId");
ALTER TABLE "workspace_model_usages"
    ADD CONSTRAINT "workspace_model_usages_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_distillation_runs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "triggerCount" INTEGER NOT NULL,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_distillation_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_distillation_runs_workspaceId_kind_triggerCount_key"
    ON "memory_distillation_runs"("workspaceId", "kind", "triggerCount");
CREATE INDEX "memory_distillation_runs_workspaceId_idx"
    ON "memory_distillation_runs"("workspaceId");
ALTER TABLE "memory_distillation_runs"
    ADD CONSTRAINT "memory_distillation_runs_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
