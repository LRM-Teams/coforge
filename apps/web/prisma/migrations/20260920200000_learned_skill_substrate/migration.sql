-- Group Memory substrate (ADR 0052, slice 1): Memory Episodes (immutable
-- admitted PublicChannel windows), Memory Insights (immutable revision chains),
-- insight-episode provenance links (supports/contradicts), append-only score
-- events, and lossless Interaction Links. Deliberately NOT ported from the
-- feat/group-memory branch: the derived memory_graph_edges projection —
-- exploration expands along provenance edges + the trigram seam instead.
-- DirectConversation content never reaches these tables.
--
-- Maintenance note: the two `USING gin (… gin_trgm_ops)` indexes below are
-- raw-SQL objects schema.prisma cannot express; `prisma migrate dev` will
-- propose DROP INDEX for them. This repo authors migrations by hand and
-- applies them with `prisma migrate deploy`; never accept a generated DROP of
-- the trgm indexes. The pg_trgm extension itself is drift-free.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE "memory_episodes" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "taskMessageId" UUID,
    "kind" TEXT NOT NULL,
    "startSequence" INTEGER NOT NULL,
    "endSequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "outcome" TEXT,
    "outcomeReason" TEXT,
    "keySteps" TEXT,
    "distilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "memory_episodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_insights" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "supersededById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "memory_insights_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_insight_episode_links" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "insightId" UUID NOT NULL,
    "episodeId" UUID NOT NULL,
    "polarity" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_insight_episode_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_score_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "insightId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "operationKey" TEXT NOT NULL,
    "taskId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_score_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_interaction_links" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "fromMessageId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "toMessageId" UUID,
    "toMemberId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_interaction_links_pkey" PRIMARY KEY ("id")
);

-- Episodes: one row per (workspace, conversation, kind, sequence bounds); a
-- byte-identical replay maps to the same row, content drift under the same
-- key is rejected by the admission module (contentHash).
CREATE UNIQUE INDEX "memory_episodes_workspaceId_conversationId_kind_startSequen_key"
    ON "memory_episodes"("workspaceId", "conversationId", "kind", "startSequence", "endSequence");
CREATE INDEX "memory_episodes_workspaceId_taskMessageId_idx"
    ON "memory_episodes"("workspaceId", "taskMessageId");
CREATE INDEX "memory_episodes_workspaceId_distilledAt_idx"
    ON "memory_episodes"("workspaceId", "distilledAt");

-- Insights: chain heads are `supersededById IS NULL`; retrieval filters them.
CREATE INDEX "memory_insights_workspaceId_supersededById_idx"
    ON "memory_insights"("workspaceId", "supersededById");

CREATE UNIQUE INDEX "memory_insight_episode_links_insightId_episodeId_key"
    ON "memory_insight_episode_links"("insightId", "episodeId");
CREATE INDEX "memory_insight_episode_links_workspaceId_episodeId_idx"
    ON "memory_insight_episode_links"("workspaceId", "episodeId");

-- Score events: idempotent by caller operation key, per Workspace.
CREATE UNIQUE INDEX "memory_score_events_workspaceId_operationKey_key"
    ON "memory_score_events"("workspaceId", "operationKey");
CREATE INDEX "memory_score_events_workspaceId_insightId_idx"
    ON "memory_score_events"("workspaceId", "insightId");

CREATE UNIQUE INDEX "memory_interaction_links_fromMessageId_kind_targetKey_key"
    ON "memory_interaction_links"("fromMessageId", "kind", "targetKey");
CREATE INDEX "memory_interaction_links_workspaceId_conversationId_idx"
    ON "memory_interaction_links"("workspaceId", "conversationId");
CREATE INDEX "memory_interaction_links_toMemberId_idx"
    ON "memory_interaction_links"("toMemberId");
CREATE INDEX "memory_interaction_links_toMessageId_idx"
    ON "memory_interaction_links"("toMessageId");

ALTER TABLE "memory_episodes"
    ADD CONSTRAINT "memory_episodes_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_episodes"
    ADD CONSTRAINT "memory_episodes_conversationId_workspaceId_fkey"
    FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_insights"
    ADD CONSTRAINT "memory_insights_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict by design: revision chains are immutable audit history.
ALTER TABLE "memory_insights"
    ADD CONSTRAINT "memory_insights_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "memory_insights"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memory_insight_episode_links"
    ADD CONSTRAINT "memory_insight_episode_links_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_insight_episode_links"
    ADD CONSTRAINT "memory_insight_episode_links_insightId_fkey"
    FOREIGN KEY ("insightId") REFERENCES "memory_insights"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_insight_episode_links"
    ADD CONSTRAINT "memory_insight_episode_links_episodeId_fkey"
    FOREIGN KEY ("episodeId") REFERENCES "memory_episodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_score_events"
    ADD CONSTRAINT "memory_score_events_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_score_events"
    ADD CONSTRAINT "memory_score_events_insightId_fkey"
    FOREIGN KEY ("insightId") REFERENCES "memory_insights"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_interaction_links"
    ADD CONSTRAINT "memory_interaction_links_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_interaction_links"
    ADD CONSTRAINT "memory_interaction_links_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_interaction_links"
    ADD CONSTRAINT "memory_interaction_links_fromMessageId_fkey"
    FOREIGN KEY ("fromMessageId") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_interaction_links"
    ADD CONSTRAINT "memory_interaction_links_toMessageId_fkey"
    FOREIGN KEY ("toMessageId") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_interaction_links"
    ADD CONSTRAINT "memory_interaction_links_toMemberId_fkey"
    FOREIGN KEY ("toMemberId") REFERENCES "conversation_members"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Lexical similarity seam: pg_trgm ranking over episode bodies and insight
-- statements. Raw-SQL GIN indexes — Prisma cannot express opclasses.
CREATE INDEX "memory_episodes_body_trgm_idx"
    ON "memory_episodes" USING gin ("body" gin_trgm_ops);
CREATE INDEX "memory_insights_statement_trgm_idx"
    ON "memory_insights" USING gin ("statement" gin_trgm_ops);
