-- CreateTable
CREATE TABLE "daemon_credential_revocations" (
    "api_key_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daemon_credential_revocations_pkey" PRIMARY KEY ("api_key_hash")
);

-- CreateIndex
CREATE INDEX "daemon_credential_revocations_revoked_at_idx" ON "daemon_credential_revocations"("revoked_at");
