CREATE TABLE "ComputerModelCatalog" (
    "id" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "models" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComputerModelCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComputerModelCatalog_computerId_provider_key"
ON "ComputerModelCatalog"("computerId", "provider");

CREATE INDEX "ComputerModelCatalog_computerId_idx"
ON "ComputerModelCatalog"("computerId");

ALTER TABLE "ComputerModelCatalog"
ADD CONSTRAINT "ComputerModelCatalog_computerId_fkey"
FOREIGN KEY ("computerId") REFERENCES "Computer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
