UPDATE "computer_runtimes"
SET "isPublic" = false
WHERE "computerId" IN (
  SELECT "computerId"
  FROM "workspace_computers"
  GROUP BY "computerId"
  HAVING COUNT(*) > 1
);

WITH retained_connections AS (
  SELECT DISTINCT ON ("computerId")
    "computerId",
    "workspaceId"
  FROM "workspace_computers"
  ORDER BY "computerId", "createdAt" DESC, "id" DESC
)
UPDATE "agents"
SET "computerId" = NULL
FROM retained_connections
WHERE "agents"."computerId" = retained_connections."computerId"
  AND "agents"."workspaceId" <> retained_connections."workspaceId";

WITH ranked_connections AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "computerId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS position
  FROM "workspace_computers"
)
DELETE FROM "workspace_computers"
USING ranked_connections
WHERE "workspace_computers"."id" = ranked_connections."id"
  AND ranked_connections.position > 1;

CREATE UNIQUE INDEX "workspace_computers_computerId_key"
ON "workspace_computers"("computerId");
