-- LearnedSkill artifacts + proposals + Proposal Ledger (ADR 0052, slices 3/5).
-- Immutable revisions identified by (lineage, version, content digest); the
-- supersedes edge is `parentRevisionId`; grounding provenance edges are
-- skill_proposal_groundings (insight | episode — kind-agnostic, at least one
-- episode grounding required at admission for every artifact kind).

CREATE TABLE "learned_skills" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currentRevisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "learned_skills_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "learned_skills_workspaceId_key_key"
    ON "learned_skills"("workspaceId", "key");
CREATE INDEX "learned_skills_workspaceId_idx"
    ON "learned_skills"("workspaceId");

CREATE TABLE "learned_skill_revisions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "parentRevisionId" UUID,
    "state" TEXT NOT NULL DEFAULT 'active',
    "proposalId" UUID,
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "learned_skill_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "learned_skill_revisions_skillId_version_key"
    ON "learned_skill_revisions"("skillId", "version");
CREATE INDEX "learned_skill_revisions_workspaceId_state_idx"
    ON "learned_skill_revisions"("workspaceId", "state");
CREATE INDEX "learned_skill_revisions_workspaceId_parentRevisionId_idx"
    ON "learned_skill_revisions"("workspaceId", "parentRevisionId");

CREATE TABLE "learned_skill_score_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "operationKey" TEXT NOT NULL,
    "offerDeliveryId" UUID,
    "taskId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "learned_skill_score_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "learned_skill_score_events_workspaceId_operationKey_key"
    ON "learned_skill_score_events"("workspaceId", "operationKey");
CREATE INDEX "learned_skill_score_events_workspaceId_revisionId_idx"
    ON "learned_skill_score_events"("workspaceId", "revisionId");

CREATE TABLE "skill_proposals" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "targetSkillId" UUID,
    "parentRevisionId" UUID,
    "proposedBody" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "skill_proposals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "skill_proposals_workspaceId_status_createdAt_idx"
    ON "skill_proposals"("workspaceId", "status", "createdAt");
CREATE INDEX "skill_proposals_targetSkillId_idx"
    ON "skill_proposals"("targetSkillId");
CREATE UNIQUE INDEX "learned_skills_currentRevisionId_key"
    ON "learned_skills"("currentRevisionId");

CREATE TABLE "skill_proposal_groundings" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "insightId" UUID,
    "episodeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_proposal_groundings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "skill_proposal_groundings_proposalId_targetKey_key"
    ON "skill_proposal_groundings"("proposalId", "targetKey");
CREATE INDEX "skill_proposal_groundings_workspaceId_insightId_idx"
    ON "skill_proposal_groundings"("workspaceId", "insightId");
CREATE INDEX "skill_proposal_groundings_workspaceId_episodeId_idx"
    ON "skill_proposal_groundings"("workspaceId", "episodeId");

CREATE TABLE "skill_proposal_ledger_entries" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "proposalId" UUID,
    "revisionId" UUID,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_proposal_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "skill_proposal_ledger_entries_workspaceId_createdAt_idx"
    ON "skill_proposal_ledger_entries"("workspaceId", "createdAt");
CREATE INDEX "skill_proposal_ledger_entries_proposalId_idx"
    ON "skill_proposal_ledger_entries"("proposalId");

ALTER TABLE "learned_skills"
    ADD CONSTRAINT "learned_skills_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learned_skill_revisions"
    ADD CONSTRAINT "learned_skill_revisions_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learned_skill_revisions"
    ADD CONSTRAINT "learned_skill_revisions_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "learned_skills"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- The supersedes edge: immutable audit history, restrict deletion.
ALTER TABLE "learned_skill_revisions"
    ADD CONSTRAINT "learned_skill_revisions_parentRevisionId_fkey"
    FOREIGN KEY ("parentRevisionId") REFERENCES "learned_skill_revisions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "learned_skill_revisions"
    ADD CONSTRAINT "learned_skill_revisions_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "skill_proposals"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "learned_skills"
    ADD CONSTRAINT "learned_skills_currentRevisionId_fkey"
    FOREIGN KEY ("currentRevisionId") REFERENCES "learned_skill_revisions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learned_skill_score_events"
    ADD CONSTRAINT "learned_skill_score_events_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learned_skill_score_events"
    ADD CONSTRAINT "learned_skill_score_events_revisionId_fkey"
    FOREIGN KEY ("revisionId") REFERENCES "learned_skill_revisions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposals"
    ADD CONSTRAINT "skill_proposals_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposals"
    ADD CONSTRAINT "skill_proposals_targetSkillId_fkey"
    FOREIGN KEY ("targetSkillId") REFERENCES "learned_skills"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposals"
    ADD CONSTRAINT "skill_proposals_parentRevisionId_fkey"
    FOREIGN KEY ("parentRevisionId") REFERENCES "learned_skill_revisions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "skill_proposal_groundings"
    ADD CONSTRAINT "skill_proposal_groundings_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposal_groundings"
    ADD CONSTRAINT "skill_proposal_groundings_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "skill_proposals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposal_groundings"
    ADD CONSTRAINT "skill_proposal_groundings_insightId_fkey"
    FOREIGN KEY ("insightId") REFERENCES "memory_insights"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposal_groundings"
    ADD CONSTRAINT "skill_proposal_groundings_episodeId_fkey"
    FOREIGN KEY ("episodeId") REFERENCES "memory_episodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposal_ledger_entries"
    ADD CONSTRAINT "skill_proposal_ledger_entries_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposal_ledger_entries"
    ADD CONSTRAINT "skill_proposal_ledger_entries_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "skill_proposals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_proposal_ledger_entries"
    ADD CONSTRAINT "skill_proposal_ledger_entries_revisionId_fkey"
    FOREIGN KEY ("revisionId") REFERENCES "learned_skill_revisions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Skill seeding for the similarity seam: trigram index over the denormalized
-- retrieval text (name + branch conditions / instructions). Raw-SQL GIN index —
-- same accepted-drift class as the substrate's two trgm indexes.
CREATE INDEX "learned_skill_revisions_searchText_trgm_idx"
    ON "learned_skill_revisions" USING gin ("searchText" gin_trgm_ops);
