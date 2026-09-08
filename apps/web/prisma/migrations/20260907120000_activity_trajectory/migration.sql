ALTER TABLE "agent_activities" RENAME COLUMN "activity" TO "detailKind";
ALTER TABLE "agent_activities" RENAME COLUMN "message" TO "detail";
ALTER TABLE "agent_activities" RENAME COLUMN "diagnosticErrorClass" TO "runtimeErrorClass";
ALTER TABLE "agent_activities" RENAME COLUMN "diagnosticReason" TO "runtimeErrorReason";
ALTER TABLE "agent_activities" RENAME COLUMN "diagnosticFingerprint" TO "runtimeErrorFingerprint";
ALTER TABLE "agent_activities" ADD COLUMN "entries" JSONB;
