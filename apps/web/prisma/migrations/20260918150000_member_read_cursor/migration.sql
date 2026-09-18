-- Human member read cursor over top-level messages (ADR 0043).
-- One-time baseline: existing member rows start already-read so nobody is
-- badged for history that predates the cursor. New member rows start at 0.
ALTER TABLE "conversation_members" ADD COLUMN     "readThroughSequence" INTEGER NOT NULL DEFAULT 0;

UPDATE "conversation_members" SET "readThroughSequence" = COALESCE(
  (SELECT MAX(m."sequence") FROM "messages" m
    WHERE m."conversationId" = "conversation_members"."conversationId"
      AND m."threadRootId" IS NULL),
  0
);