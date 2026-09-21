-- legacy Group Memory tables were never on this base; replacement is create-only.

CREATE TABLE "causal_workspace_tenants" (
    "workspace_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "memory_agent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "causal_workspace_tenants_pkey" PRIMARY KEY ("workspace_id")
);

CREATE TABLE "admitted_segment_ingest_ledgers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "admitted_segment_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_message_ids" TEXT[] NOT NULL,
    "source_payload_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "sanitized_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admitted_segment_ingest_ledgers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "segment_source_messages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "admitted_segment_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,

    CONSTRAINT "segment_source_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "causal_citation_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "citation_id" TEXT NOT NULL,
    "causal_item_id" TEXT NOT NULL,
    "causal_path_id" TEXT,
    "admitted_segment_id" TEXT NOT NULL,
    "source_message_ids" TEXT[] NOT NULL,
    "bound_operation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "causal_citation_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "causal_correction_proposal_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "causal_item_id" TEXT NOT NULL,
    "contradictory_citation_ids" TEXT[] NOT NULL,
    "rationale" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "causal_correction_proposal_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "causal_supersession_results" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "superseded" BOOLEAN NOT NULL,
    "audit_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "causal_supersession_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admitted_segment_ingest_ledgers_workspace_id_operation_id_key" ON "admitted_segment_ingest_ledgers"("workspace_id", "operation_id");
CREATE UNIQUE INDEX "admitted_segment_ingest_ledgers_workspace_id_admitted_segment_id_key" ON "admitted_segment_ingest_ledgers"("workspace_id", "admitted_segment_id");
CREATE INDEX "admitted_segment_ingest_ledgers_workspace_id_state_idx" ON "admitted_segment_ingest_ledgers"("workspace_id", "state");
CREATE UNIQUE INDEX "segment_source_messages_workspace_id_admitted_segment_id_message_id_key" ON "segment_source_messages"("workspace_id", "admitted_segment_id", "message_id");
CREATE UNIQUE INDEX "causal_citation_records_workspace_id_citation_id_key" ON "causal_citation_records"("workspace_id", "citation_id");
CREATE INDEX "causal_citation_records_workspace_id_bound_operation_id_idx" ON "causal_citation_records"("workspace_id", "bound_operation_id");
CREATE UNIQUE INDEX "causal_correction_proposal_records_workspace_id_proposal_id_key" ON "causal_correction_proposal_records"("workspace_id", "proposal_id");
CREATE UNIQUE INDEX "causal_correction_proposal_records_workspace_id_operation_id_key" ON "causal_correction_proposal_records"("workspace_id", "operation_id");
CREATE UNIQUE INDEX "causal_supersession_results_workspace_id_proposal_id_key" ON "causal_supersession_results"("workspace_id", "proposal_id");
CREATE INDEX "causal_workspace_tenants_memory_agent_id_idx" ON "causal_workspace_tenants"("memory_agent_id");

ALTER TABLE "causal_workspace_tenants" ADD CONSTRAINT "causal_workspace_tenants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "causal_workspace_tenants" ADD CONSTRAINT "causal_workspace_tenants_memory_agent_id_fkey" FOREIGN KEY ("memory_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "admitted_segment_ingest_ledgers" ADD CONSTRAINT "admitted_segment_ingest_ledgers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "segment_source_messages" ADD CONSTRAINT "segment_source_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "segment_source_messages" ADD CONSTRAINT "segment_source_messages_workspace_id_admitted_segment_id_fkey" FOREIGN KEY ("workspace_id", "admitted_segment_id") REFERENCES "admitted_segment_ingest_ledgers"("workspace_id", "admitted_segment_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "causal_citation_records" ADD CONSTRAINT "causal_citation_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "causal_correction_proposal_records" ADD CONSTRAINT "causal_correction_proposal_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "causal_supersession_results" ADD CONSTRAINT "causal_supersession_results_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "causal_supersession_results" ADD CONSTRAINT "causal_supersession_results_workspace_id_proposal_id_fkey" FOREIGN KEY ("workspace_id", "proposal_id") REFERENCES "causal_correction_proposal_records"("workspace_id", "proposal_id") ON DELETE CASCADE ON UPDATE CASCADE;
