DO $$
BEGIN
  IF EXISTS (
    SELECT inventory."computerId"
    FROM (
      SELECT "computerId" FROM "computer_runtimes"
      UNION
      SELECT "computerId" FROM "computer_model_catalogs"
    ) AS inventory
    LEFT JOIN "workspace_computers" AS connection
      ON connection."computerId" = inventory."computerId"
    GROUP BY inventory."computerId"
    HAVING COUNT(connection."workspaceId") <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate legacy runtime inventory: refresh Workspace-scoped inventory before migrating ambiguous legacy inventory';
  END IF;
END $$;

ALTER TABLE "computer_runtimes" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "computer_model_catalogs" ADD COLUMN "workspaceId" UUID;

UPDATE "computer_runtimes" AS runtime
SET "workspaceId" = connection."workspaceId"
FROM "workspace_computers" AS connection
WHERE connection."computerId" = runtime."computerId";

UPDATE "computer_model_catalogs" AS catalog
SET "workspaceId" = connection."workspaceId"
FROM "workspace_computers" AS connection
WHERE connection."computerId" = catalog."computerId";

ALTER TABLE "computer_runtimes" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "computer_model_catalogs" ALTER COLUMN "workspaceId" SET NOT NULL;

DROP INDEX "computer_runtimes_computerId_provider_key";
DROP INDEX "computer_runtimes_computerId_idx";
DROP INDEX "computer_model_catalogs_computerId_provider_key";
DROP INDEX "computer_model_catalogs_computerId_idx";

CREATE UNIQUE INDEX "computer_runtimes_workspaceId_computerId_provider_key"
ON "computer_runtimes"("workspaceId", "computerId", "provider");
CREATE INDEX "computer_runtimes_workspaceId_computerId_idx"
ON "computer_runtimes"("workspaceId", "computerId");
CREATE UNIQUE INDEX "computer_model_catalogs_workspaceId_computerId_provider_key"
ON "computer_model_catalogs"("workspaceId", "computerId", "provider");
CREATE INDEX "computer_model_catalogs_workspaceId_computerId_idx"
ON "computer_model_catalogs"("workspaceId", "computerId");

ALTER TABLE "computer_runtimes"
ADD CONSTRAINT "computer_runtimes_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_model_catalogs"
ADD CONSTRAINT "computer_model_catalogs_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
