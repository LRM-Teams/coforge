-- A deleted Agent whose name was reused was once renamed to `<name>-deleted-<uuid>`. That name
-- can exceed the 60-character username bound, and every history read that includes the deleted
-- Agent's messages then fails. Rename those rows to the current format:
-- `<first 39 characters of the name, trailing hyphens trimmed>-deleted-<12 hex digits of the id>`.
UPDATE "agents"
SET "name" = rtrim(
    left(
      substring("name" FROM '^(.*)-deleted-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
      39
    ),
    '-'
  ) || '-deleted-' || left(replace("id"::text, '-', ''), 12)
WHERE "deletedAt" IS NOT NULL
  AND length("name") > 60
  AND "name" ~ '-deleted-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
