CREATE TABLE "reminders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "workspaceId" UUID NOT NULL,
  "ownerAgentId" UUID NOT NULL, "computerId" UUID NOT NULL, "title" TEXT NOT NULL,
  "target" TEXT NOT NULL, "messageId" UUID NOT NULL, "fireAt" TIMESTAMPTZ NOT NULL,
  "repeat" TEXT, "timezone" TEXT, "status" TEXT NOT NULL DEFAULT 'scheduled',
  "version" INTEGER NOT NULL DEFAULT 1, "firedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reminders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "reminders_ownerAgentId_workspaceId_fkey" FOREIGN KEY ("ownerAgentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE,
  CONSTRAINT "reminders_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE,
  CONSTRAINT "reminders_workspaceId_computerId_fkey" FOREIGN KEY ("workspaceId", "computerId") REFERENCES "workspace_computers"("workspaceId", "computerId") ON DELETE CASCADE,
  CONSTRAINT "reminders_id_workspaceId_key" UNIQUE ("id", "workspaceId")
);
CREATE INDEX "reminders_workspaceId_ownerAgentId_status_fireAt_idx" ON "reminders"("workspaceId", "ownerAgentId", "status", "fireAt");

CREATE TABLE "reminder_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "reminderId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL,
  "time" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "scheduledFor" TIMESTAMPTZ NOT NULL,
  "nextFireAt" TIMESTAMPTZ,
  CONSTRAINT "reminder_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reminder_events_reminderId_workspaceId_fkey" FOREIGN KEY ("reminderId", "workspaceId") REFERENCES "reminders"("id", "workspaceId") ON DELETE CASCADE,
  CONSTRAINT "reminder_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE
);
CREATE INDEX "reminder_events_reminderId_time_idx" ON "reminder_events"("reminderId", "time" DESC);

CREATE TABLE "reminder_fire_receipts" (
  "requestId" VARCHAR(128) NOT NULL, "reminderId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL, "computerId" UUID NOT NULL, "agentId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "response" BYTEA NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminder_fire_receipts_pkey" PRIMARY KEY ("reminderId", "requestId"),
  CONSTRAINT "reminder_fire_receipts_reminderId_workspaceId_fkey" FOREIGN KEY ("reminderId", "workspaceId") REFERENCES "reminders"("id", "workspaceId") ON DELETE CASCADE
);

CREATE TABLE "reminder_operation_receipts" (
  "workspaceId" UUID NOT NULL, "agentId" UUID NOT NULL,
  "requestId" VARCHAR(128) NOT NULL, "fingerprint" TEXT NOT NULL,
  "response" BYTEA NOT NULL, "reminderId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminder_operation_receipts_pkey" PRIMARY KEY ("agentId", "requestId"),
  CONSTRAINT "reminder_operation_receipts_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE,
  CONSTRAINT "reminder_operation_receipts_reminderId_workspaceId_fkey" FOREIGN KEY ("reminderId", "workspaceId") REFERENCES "reminders"("id", "workspaceId") ON DELETE CASCADE
);
CREATE INDEX "reminder_operation_receipts_reminderId_idx" ON "reminder_operation_receipts"("reminderId");
