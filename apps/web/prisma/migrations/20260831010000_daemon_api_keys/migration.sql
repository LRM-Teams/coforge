-- CreateTable
CREATE TABLE "daemon_api_keys" (
    "id" UUID NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "computer_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    CONSTRAINT "daemon_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daemon_api_keys_api_key_hash_key" ON "daemon_api_keys"("api_key_hash");
CREATE INDEX "daemon_api_keys_workspace_id_computer_id_idx" ON "daemon_api_keys"("workspace_id", "computer_id");
CREATE INDEX "daemon_api_keys_owner_id_idx" ON "daemon_api_keys"("owner_id");
ALTER TABLE "daemon_api_keys" ADD CONSTRAINT "daemon_api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daemon_api_keys" ADD CONSTRAINT "daemon_api_keys_computer_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "Computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daemon_api_keys" ADD CONSTRAINT "daemon_api_keys_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
