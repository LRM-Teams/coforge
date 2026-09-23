-- Task history keeps one generic payload per event instead of typed before/after columns, so
-- status and assignee changes are recorded alongside title/description amendments.
ALTER TABLE "task_history_events" ADD COLUMN "payload" JSONB;

-- Every existing row is an amendment; move its before/after columns into payload.changes.
UPDATE "task_history_events"
SET "payload" = jsonb_build_object(
  'changes',
  CASE WHEN "afterTitle" IS NOT NULL
    THEN jsonb_build_object('title', jsonb_build_object('from', "beforeTitle", 'to', "afterTitle"))
    ELSE '{}'::jsonb END
  || CASE WHEN "beforeDescription" IS NOT NULL OR "afterDescription" IS NOT NULL
    THEN jsonb_build_object(
      'description', jsonb_build_object('from', "beforeDescription", 'to', "afterDescription"))
    ELSE '{}'::jsonb END
);

ALTER TABLE "task_history_events" ALTER COLUMN "payload" SET NOT NULL;

ALTER TABLE "task_history_events" DROP COLUMN "afterDescription",
DROP COLUMN "afterTitle",
DROP COLUMN "beforeDescription",
DROP COLUMN "beforeTitle";

ALTER TABLE "task_history_events" RENAME COLUMN "sequence" TO "seq";
ALTER TABLE "task_history_events" RENAME COLUMN "actorKind" TO "actorType";
ALTER INDEX "task_history_events_taskMessageId_sequence_key"
  RENAME TO "task_history_events_taskMessageId_seq_key";
