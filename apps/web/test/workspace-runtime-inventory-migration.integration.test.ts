import { afterAll, expect, test } from "bun:test";
import { Pool } from "pg";

const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;
const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20260907100000_workspace_runtime_inventory/migration.sql",
    import.meta.url,
  ),
).text();

afterAll(async () => {
  await pool?.end();
});

async function createLegacySchema(bindingCount: number) {
  const schema = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool!.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE "workspaces" ("id" UUID PRIMARY KEY);
    CREATE TABLE "workspace_computers" ("workspaceId" UUID NOT NULL, "computerId" UUID NOT NULL);
    CREATE TABLE "computer_runtimes" ("computerId" UUID NOT NULL, "provider" TEXT NOT NULL);
    CREATE TABLE "computer_model_catalogs" ("computerId" UUID NOT NULL, "provider" TEXT NOT NULL);
    CREATE UNIQUE INDEX "computer_runtimes_computerId_provider_key" ON "computer_runtimes"("computerId", "provider");
    CREATE INDEX "computer_runtimes_computerId_idx" ON "computer_runtimes"("computerId");
    CREATE UNIQUE INDEX "computer_model_catalogs_computerId_provider_key" ON "computer_model_catalogs"("computerId", "provider");
    CREATE INDEX "computer_model_catalogs_computerId_idx" ON "computer_model_catalogs"("computerId");
    INSERT INTO "computer_runtimes" VALUES ('00000000-0000-0000-0000-000000000001', 'codex');
    INSERT INTO "computer_model_catalogs" VALUES ('00000000-0000-0000-0000-000000000001', 'codex');
  `);
  for (let index = 1; index <= bindingCount; index++) {
    const workspaceId = `00000000-0000-0000-0000-${index.toString().padStart(12, "0")}`;
    await client.query(`INSERT INTO "workspaces" VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO "workspace_computers" VALUES ($1, $2)`, [
      workspaceId,
      "00000000-0000-0000-0000-000000000001",
    ]);
  }
  return { client, schema };
}

test.skipIf(!connectionString)(
  "migrates one binding and rejects ambiguous legacy inventory intact",
  async () => {
    const canonical = await createLegacySchema(1);
    const ambiguous = await createLegacySchema(2);
    try {
      await canonical.client.query(migration);
      expect(
        await canonical.client.query(`SELECT "workspaceId"::text FROM "computer_runtimes"`),
      ).toMatchObject({ rows: [{ workspaceId: "00000000-0000-0000-0000-000000000001" }] });

      await expect(ambiguous.client.query(migration)).rejects.toThrow(
        "refresh Workspace-scoped inventory before migrating ambiguous legacy inventory",
      );
      expect(await ambiguous.client.query(`SELECT * FROM "computer_runtimes"`)).toMatchObject({
        rowCount: 1,
        rows: [{ computerId: "00000000-0000-0000-0000-000000000001", provider: "codex" }],
      });
      expect(await ambiguous.client.query(`SELECT * FROM "computer_model_catalogs"`)).toMatchObject(
        {
          rowCount: 1,
          rows: [{ computerId: "00000000-0000-0000-0000-000000000001", provider: "codex" }],
        },
      );
    } finally {
      canonical.client.release();
      ambiguous.client.release();
      const cleanup = await pool!.connect();
      try {
        await cleanup.query(`DROP SCHEMA "${canonical.schema}" CASCADE`);
        await cleanup.query(`DROP SCHEMA "${ambiguous.schema}" CASCADE`);
      } finally {
        cleanup.release();
      }
    }
  },
);
