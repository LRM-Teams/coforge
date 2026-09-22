-- Workspace Memory Profile persistence (P2). Additive only; causal migrations stay immutable.
-- Credential plaintext is never stored. CHECK constraints encode the C4 frozen vocabularies.

-- CreateTable
CREATE TABLE "workspace_memory_profiles" (
    "workspace_id" UUID NOT NULL,
    "desired" TEXT NOT NULL,
    "observed" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "activation_cursor_kind" TEXT,
    "activation_occurred_at" TIMESTAMP(3),
    "activation_message_id" TEXT,
    "reconcile_kind" TEXT,
    "sanitized_failure_code" TEXT,
    "sanitized_failure_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_memory_profiles_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "workspace_memory_profiles_desired_check" CHECK ("desired" IN ('off', 'openviking', 'causal_openviking')),
    CONSTRAINT "workspace_memory_profiles_observed_check" CHECK ("observed" IN ('provisioning', 'ready', 'degraded', 'switching', 'error')),
    CONSTRAINT "workspace_memory_profiles_generation_check" CHECK ("generation" >= 0),
    CONSTRAINT "workspace_memory_profiles_reconcile_kind_check" CHECK ("reconcile_kind" IS NULL OR "reconcile_kind" IN ('provision', 'switch')),
    CONSTRAINT "workspace_memory_profiles_activation_cursor_check" CHECK (
        ("activation_cursor_kind" IS NULL AND "activation_occurred_at" IS NULL AND "activation_message_id" IS NULL)
        OR (
            "activation_cursor_kind" = 'time'
            AND "activation_occurred_at" IS NOT NULL
            AND "activation_message_id" IS NULL
        )
        OR (
            "activation_cursor_kind" = 'message'
            AND "activation_occurred_at" IS NOT NULL
            AND "activation_message_id" IS NOT NULL
            AND "activation_message_id" <> ''
        )
    ),
    CONSTRAINT "workspace_memory_profiles_sanitized_failure_check" CHECK (
        ("sanitized_failure_code" IS NULL AND "sanitized_failure_message" IS NULL)
        OR ("sanitized_failure_code" IS NOT NULL AND "sanitized_failure_message" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "openviking_bindings" (
    "workspace_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "service_identity_id" TEXT NOT NULL,
    "credential_ref" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "openviking_bindings_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "openviking_bindings_credential_ref_check" CHECK ("credential_ref" LIKE 'secret:%' AND "credential_ref" <> 'secret:'),
    CONSTRAINT "openviking_bindings_generation_check" CHECK ("generation" >= 0)
);

-- CreateTable
CREATE TABLE "openviking_mapped_identities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "openviking_user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "openviking_mapped_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "openviking_mapped_identities_actor_kind_check" CHECK ("actor_kind" IN ('owner', 'admin', 'member', 'agent', 'memory_agent', 'projection_worker')),
    CONSTRAINT "openviking_mapped_identities_role_check" CHECK ("role" IN ('admin', 'user', 'service')),
    CONSTRAINT "openviking_mapped_identities_access_check" CHECK ("access" IN ('workspace_admin', 'own_namespace', 'explicit_grant', 'readonly_shared', 'projection_only')),
    CONSTRAINT "openviking_mapped_identities_generation_check" CHECK ("generation" >= 0)
);

-- CreateTable
CREATE TABLE "admitted_public_channel_segments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "segment_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conversation_kind" TEXT NOT NULL,
    "source_payload_hash" TEXT NOT NULL,
    "profile_generation" INTEGER NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admitted_public_channel_segments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admitted_public_channel_segments_kind_check" CHECK ("kind" IN ('completed_task', 'quiet_window')),
    CONSTRAINT "admitted_public_channel_segments_conversation_kind_check" CHECK ("conversation_kind" = 'public_channel'),
    CONSTRAINT "admitted_public_channel_segments_profile_generation_check" CHECK ("profile_generation" >= 0)
);

-- CreateTable
CREATE TABLE "admitted_segment_source_messages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "segment_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admitted_segment_source_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admitted_segment_dispatches" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "segment_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "sink_profile" TEXT NOT NULL,
    "profile_generation" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "sanitized_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admitted_segment_dispatches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admitted_segment_dispatches_sink_profile_check" CHECK ("sink_profile" IN ('openviking', 'causal_openviking')),
    CONSTRAINT "admitted_segment_dispatches_state_check" CHECK ("state" IN ('pending', 'delivered', 'retryable_failure')),
    CONSTRAINT "admitted_segment_dispatches_attempt_count_check" CHECK ("attempt_count" >= 0),
    CONSTRAINT "admitted_segment_dispatches_profile_generation_check" CHECK ("profile_generation" >= 0)
);

-- CreateTable
CREATE TABLE "openviking_citation_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "citation_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "content_hash" TEXT,
    "content_version" TEXT,
    "matched_level" TEXT NOT NULL,
    "title" TEXT,
    "excerpt" TEXT,
    "bound_operation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "openviking_citation_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "openviking_citation_records_matched_level_check" CHECK ("matched_level" IN ('L0', 'L1', 'L2')),
    CONSTRAINT "openviking_citation_records_version_check" CHECK (
        ("content_hash" IS NOT NULL AND "content_hash" <> '')
        OR ("content_version" IS NOT NULL AND "content_version" <> '')
    ),
    CONSTRAINT "openviking_citation_records_display_check" CHECK (
        ("title" IS NOT NULL AND "title" <> '')
        OR ("excerpt" IS NOT NULL AND "excerpt" <> '')
    )
);

-- CreateTable
CREATE TABLE "memory_offer_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "operation_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "recipient_agent_id" TEXT NOT NULL,
    "recipient_rationale" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_offer_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_offer_citations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "offer_operation_id" TEXT NOT NULL,
    "citation_kind" TEXT NOT NULL,
    "citation_id" TEXT NOT NULL,
    "openviking_citation_id" TEXT,
    "causal_citation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_offer_citations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_offer_citations_kind_check" CHECK ("citation_kind" IN ('openviking', 'causal_memory')),
    CONSTRAINT "memory_offer_citations_typed_ref_check" CHECK (
        (
            "citation_kind" = 'openviking'
            AND "openviking_citation_id" IS NOT NULL
            AND "causal_citation_id" IS NULL
            AND "openviking_citation_id" = "citation_id"
        )
        OR (
            "citation_kind" = 'causal_memory'
            AND "causal_citation_id" IS NOT NULL
            AND "openviking_citation_id" IS NULL
            AND "causal_citation_id" = "citation_id"
        )
    )
);

-- CreateTable
CREATE TABLE "workspace_memory_cleanup_work" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "operation_id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "sanitized_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_memory_cleanup_work_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_memory_cleanup_work_target_check" CHECK ("target" IN (
        'causal_tenant',
        'openviking_account',
        'managed_causal_projection',
        'pending_projection_work',
        'openviking_binding'
    )),
    CONSTRAINT "workspace_memory_cleanup_work_state_check" CHECK ("state" IN ('pending', 'leased', 'retryable_failure', 'settled')),
    CONSTRAINT "workspace_memory_cleanup_work_attempt_count_check" CHECK ("attempt_count" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "openviking_bindings_account_id_key" ON "openviking_bindings"("account_id");

-- CreateIndex
CREATE INDEX "openviking_mapped_identities_workspace_id_openviking_user_i_idx" ON "openviking_mapped_identities"("workspace_id", "openviking_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "openviking_mapped_identities_workspace_id_actor_kind_actor__key" ON "openviking_mapped_identities"("workspace_id", "actor_kind", "actor_subject");

-- CreateIndex
CREATE INDEX "admitted_public_channel_segments_workspace_id_profile_gener_idx" ON "admitted_public_channel_segments"("workspace_id", "profile_generation");

-- CreateIndex
CREATE INDEX "admitted_public_channel_segments_workspace_id_closed_at_idx" ON "admitted_public_channel_segments"("workspace_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "admitted_public_channel_segments_workspace_id_segment_id_key" ON "admitted_public_channel_segments"("workspace_id", "segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "admitted_segment_source_messages_workspace_id_segment_id_me_key" ON "admitted_segment_source_messages"("workspace_id", "segment_id", "message_id");

-- CreateIndex
CREATE INDEX "admitted_segment_dispatches_workspace_id_state_idx" ON "admitted_segment_dispatches"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "admitted_segment_dispatches_workspace_id_segment_id_key" ON "admitted_segment_dispatches"("workspace_id", "segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "admitted_segment_dispatches_workspace_id_operation_id_key" ON "admitted_segment_dispatches"("workspace_id", "operation_id");

-- CreateIndex
CREATE INDEX "openviking_citation_records_workspace_id_bound_operation_id_idx" ON "openviking_citation_records"("workspace_id", "bound_operation_id");

-- CreateIndex
CREATE INDEX "openviking_citation_records_workspace_id_account_id_idx" ON "openviking_citation_records"("workspace_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "openviking_citation_records_workspace_id_citation_id_key" ON "openviking_citation_records"("workspace_id", "citation_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_offer_records_workspace_id_operation_id_key" ON "memory_offer_records"("workspace_id", "operation_id");

-- CreateIndex
CREATE INDEX "memory_offer_citations_workspace_id_citation_kind_citation__idx" ON "memory_offer_citations"("workspace_id", "citation_kind", "citation_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_offer_citations_workspace_id_offer_operation_id_cita_key" ON "memory_offer_citations"("workspace_id", "offer_operation_id", "citation_kind", "citation_id");

-- CreateIndex
CREATE INDEX "workspace_memory_cleanup_work_workspace_id_state_idx" ON "workspace_memory_cleanup_work"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "workspace_memory_cleanup_work_state_lease_expires_at_idx" ON "workspace_memory_cleanup_work"("state", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_memory_cleanup_work_workspace_id_operation_id_tar_key" ON "workspace_memory_cleanup_work"("workspace_id", "operation_id", "target");

-- AddForeignKey
ALTER TABLE "workspace_memory_profiles" ADD CONSTRAINT "workspace_memory_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openviking_bindings" ADD CONSTRAINT "openviking_bindings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openviking_mapped_identities" ADD CONSTRAINT "openviking_mapped_identities_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openviking_mapped_identities" ADD CONSTRAINT "openviking_mapped_identities_binding_fkey" FOREIGN KEY ("workspace_id") REFERENCES "openviking_bindings"("workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admitted_public_channel_segments" ADD CONSTRAINT "admitted_public_channel_segments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admitted_segment_source_messages" ADD CONSTRAINT "admitted_segment_source_messages_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admitted_segment_source_messages" ADD CONSTRAINT "admitted_segment_source_messages_segment_fkey" FOREIGN KEY ("workspace_id", "segment_id") REFERENCES "admitted_public_channel_segments"("workspace_id", "segment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admitted_segment_dispatches" ADD CONSTRAINT "admitted_segment_dispatches_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admitted_segment_dispatches" ADD CONSTRAINT "admitted_segment_dispatches_segment_fkey" FOREIGN KEY ("workspace_id", "segment_id") REFERENCES "admitted_public_channel_segments"("workspace_id", "segment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openviking_citation_records" ADD CONSTRAINT "openviking_citation_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_offer_records" ADD CONSTRAINT "memory_offer_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_offer_citations" ADD CONSTRAINT "memory_offer_citations_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_offer_citations" ADD CONSTRAINT "memory_offer_citations_offer_fkey" FOREIGN KEY ("workspace_id", "offer_operation_id") REFERENCES "memory_offer_records"("workspace_id", "operation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_offer_citations" ADD CONSTRAINT "memory_offer_citations_openviking_citation_fkey" FOREIGN KEY ("workspace_id", "openviking_citation_id") REFERENCES "openviking_citation_records"("workspace_id", "citation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_offer_citations" ADD CONSTRAINT "memory_offer_citations_causal_citation_fkey" FOREIGN KEY ("workspace_id", "causal_citation_id") REFERENCES "causal_citation_records"("workspace_id", "citation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memory_cleanup_work" ADD CONSTRAINT "workspace_memory_cleanup_work_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutable admitted lineage: updates are rejected; workspace cascade may still delete.
CREATE FUNCTION reject_admitted_segment_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'admitted segment lineage is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admitted_public_channel_segments_immutable
    BEFORE UPDATE ON "admitted_public_channel_segments"
    FOR EACH ROW
    EXECUTE FUNCTION reject_admitted_segment_update();

CREATE TRIGGER admitted_segment_source_messages_immutable
    BEFORE UPDATE ON "admitted_segment_source_messages"
    FOR EACH ROW
    EXECUTE FUNCTION reject_admitted_segment_update();
