-- Memory Agent substrate (ADR 0052, slice 4): the designation row (the
-- per-Workspace enablement switch), bounded exploration sessions with the
-- citation/operation idempotency ledger, and offer deliveries (insight or
-- skill revision targets — the shadow gate's signal substrate).

CREATE TABLE "memory_agent_designations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_agent_designations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_agent_designations_workspaceId_key"
    ON "memory_agent_designations"("workspaceId");
CREATE UNIQUE INDEX "memory_agent_designations_agentId_key"
    ON "memory_agent_designations"("agentId");
ALTER TABLE "memory_agent_designations"
    ADD CONSTRAINT "memory_agent_designations_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_agent_designations"
    ADD CONSTRAINT "memory_agent_designations_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "agents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_exploration_sessions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "maxSteps" INTEGER NOT NULL,
    "maxResults" INTEGER NOT NULL,
    "stepsUsed" INTEGER NOT NULL DEFAULT 0,
    "resultsServed" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'active',
    "found" BOOLEAN,
    "summary" TEXT,
    "startKey" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "memory_exploration_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_exploration_sessions_workspaceId_startKey_key"
    ON "memory_exploration_sessions"("workspaceId", "startKey");
CREATE INDEX "memory_exploration_sessions_workspaceId_agentId_idx"
    ON "memory_exploration_sessions"("workspaceId", "agentId");
ALTER TABLE "memory_exploration_sessions"
    ADD CONSTRAINT "memory_exploration_sessions_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_exploration_sessions"
    ADD CONSTRAINT "memory_exploration_sessions_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "agents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_exploration_citations" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "snippet" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_exploration_citations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_exploration_citations_sessionId_kind_targetId_key"
    ON "memory_exploration_citations"("sessionId", "kind", "targetId");
CREATE INDEX "memory_exploration_citations_sessionId_idx"
    ON "memory_exploration_citations"("sessionId");
ALTER TABLE "memory_exploration_citations"
    ADD CONSTRAINT "memory_exploration_citations_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "memory_exploration_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_exploration_operations" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "operationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_exploration_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_exploration_operations_sessionId_operationId_key"
    ON "memory_exploration_operations"("sessionId", "operationId");
CREATE INDEX "memory_exploration_operations_sessionId_idx"
    ON "memory_exploration_operations"("sessionId");
ALTER TABLE "memory_exploration_operations"
    ADD CONSTRAINT "memory_exploration_operations_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "memory_exploration_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_offer_deliveries" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "insightId" UUID,
    "skillRevisionId" UUID,
    "conversationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "explicitAsk" BOOLEAN NOT NULL DEFAULT false,
    "operationKey" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_offer_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_offer_deliveries_workspaceId_operationKey_targetRef_key"
    ON "memory_offer_deliveries"("workspaceId", "operationKey", "targetRef");
CREATE INDEX "memory_offer_deliveries_workspaceId_agentId_targetRef_idx"
    ON "memory_offer_deliveries"("workspaceId", "agentId", "targetRef");
ALTER TABLE "memory_offer_deliveries"
    ADD CONSTRAINT "memory_offer_deliveries_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_offer_deliveries"
    ADD CONSTRAINT "memory_offer_deliveries_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "agents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_offer_deliveries"
    ADD CONSTRAINT "memory_offer_deliveries_insightId_fkey"
    FOREIGN KEY ("insightId") REFERENCES "memory_insights"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_offer_deliveries"
    ADD CONSTRAINT "memory_offer_deliveries_skillRevisionId_fkey"
    FOREIGN KEY ("skillRevisionId") REFERENCES "learned_skill_revisions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_offer_deliveries"
    ADD CONSTRAINT "memory_offer_deliveries_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
