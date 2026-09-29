-- AlterTable
ALTER TABLE "agent_message_deliveries" ADD COLUMN     "mentionLaunchId" TEXT,
ADD COLUMN     "mentionOutcome" TEXT,
ADD COLUMN     "mentionReasonCategory" TEXT,
ADD COLUMN     "mentionSessionId" TEXT,
ADD COLUMN     "mentionSettledAt" TIMESTAMP(3),
ADD COLUMN     "mentionStage" TEXT,
ADD COLUMN     "mentionTerminalCode" TEXT;

-- Closed sets and their pairings: a reason exactly when the outcome is lost, an envelope's launch
-- and session together, and no mention detail on an untracked delivery.
ALTER TABLE "agent_message_deliveries"
  ADD CONSTRAINT "agent_message_deliveries_mention_outcome_check"
    CHECK ("mentionOutcome" IN ('pending', 'delivered', 'lost', 'unknown')),
  ADD CONSTRAINT "agent_message_deliveries_mention_stage_check"
    CHECK ("mentionStage" IN ('daemon_received', 'daemon_pending', 'daemon_drained')),
  ADD CONSTRAINT "agent_message_deliveries_mention_reason_category_check"
    CHECK ("mentionReasonCategory" IN ('quota', 'runtime_error', 'not_launched', 'unclassified')),
  ADD CONSTRAINT "agent_message_deliveries_mention_lost_reason_check"
    CHECK (COALESCE("mentionOutcome" = 'lost', false) = ("mentionReasonCategory" IS NOT NULL)),
  ADD CONSTRAINT "agent_message_deliveries_mention_envelope_check"
    CHECK (("mentionLaunchId" IS NULL) = ("mentionSessionId" IS NULL)),
  ADD CONSTRAINT "agent_message_deliveries_mention_tracked_check"
    CHECK ("mentionOutcome" IS NOT NULL OR ("mentionStage" IS NULL
      AND "mentionTerminalCode" IS NULL AND "mentionLaunchId" IS NULL
      AND "mentionSettledAt" IS NULL));
