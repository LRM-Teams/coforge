CREATE TABLE "device_authorizations" (
    "id" UUID NOT NULL,
    "device_code_hash" TEXT NOT NULL,
    "user_code_hash" TEXT NOT NULL,
    "user_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "last_polled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_authorizations_device_code_hash_key"
ON "device_authorizations"("device_code_hash");

CREATE UNIQUE INDEX "device_authorizations_user_code_hash_key"
ON "device_authorizations"("user_code_hash");

CREATE INDEX "device_authorizations_expires_at_idx"
ON "device_authorizations"("expires_at");

CREATE INDEX "device_authorizations_user_id_idx"
ON "device_authorizations"("user_id");

ALTER TABLE "device_authorizations"
ADD CONSTRAINT "device_authorizations_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
