-- Offer audit + citation display content used by grounded Memory Offers.

ALTER TABLE "causal_citation_records" ADD COLUMN "display_content" TEXT NOT NULL DEFAULT '';

CREATE TABLE "causal_offer_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "operation_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "recipient_agent_id" TEXT NOT NULL,
    "recipient_rationale" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "citation_ids" TEXT[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "causal_offer_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "causal_offer_records_workspace_id_operation_id_key" ON "causal_offer_records"("workspace_id", "operation_id");

ALTER TABLE "causal_offer_records" ADD CONSTRAINT "causal_offer_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
