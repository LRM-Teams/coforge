CREATE TABLE "ComputerRuntime" (
    "id" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComputerRuntime_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComputerRuntime_computerId_provider_key"
ON "ComputerRuntime"("computerId", "provider");

CREATE INDEX "ComputerRuntime_computerId_idx" ON "ComputerRuntime"("computerId");

ALTER TABLE "ComputerRuntime"
ADD CONSTRAINT "ComputerRuntime_computerId_fkey"
FOREIGN KEY ("computerId") REFERENCES "Computer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Agent" ADD COLUMN "computerId" UUID;

CREATE INDEX "Agent_computerId_idx" ON "Agent"("computerId");

ALTER TABLE "Agent"
ADD CONSTRAINT "Agent_computerId_fkey"
FOREIGN KEY ("computerId") REFERENCES "Computer"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
