-- Rename the Agent attachment upload session's idempotency key in place so existing
-- sessions keep their key (Prisma would otherwise DROP and re-ADD the column).
ALTER TABLE "attachment_upload_sessions" RENAME COLUMN "clientRequestId" TO "idempotencyKey";

-- Rename the unique index to the name Prisma derives from the new field.
ALTER INDEX "attachment_upload_sessions_agentId_clientRequestId_key" RENAME TO "attachment_upload_sessions_agentId_idempotencyKey_key";
