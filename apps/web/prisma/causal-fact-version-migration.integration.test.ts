import { afterAll, expect, test } from "bun:test";
import { Pool } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;
const migration = await Bun.file(
  new URL("./migrations/20260922090000_causal_fact_version/migration.sql", import.meta.url),
).text();

afterAll(async () => {
  await pool?.end();
});

if (!connectionString) {
  console.warn(
    "causal factVersion PostgreSQL tests not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

test.skipIf(!connectionString)(
  "fact_version backfill extracts prefixed paths and leaves unprefixed rows unchanged",
  async () => {
    const schema = `cfv_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE "causal_citation_records" (
          "id" UUID PRIMARY KEY,
          "workspace_id" UUID NOT NULL,
          "citation_id" TEXT NOT NULL,
          "causal_path_id" TEXT
        );
      `);
      await client.query(
        `INSERT INTO "causal_citation_records" ("id", "workspace_id", "citation_id", "causal_path_id")
         VALUES
           ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'prefixed', '__v3__:docs/a.md'),
           ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'bare', '__v7__')`,
      );

      await client.query(migration);

      const backfilled = await client.query(
        `SELECT "citation_id", "fact_version", "causal_path_id"
           FROM "causal_citation_records"
          ORDER BY "citation_id"`,
      );
      expect(backfilled.rows).toEqual([
        { citation_id: "bare", fact_version: 7, causal_path_id: null },
        { citation_id: "prefixed", fact_version: 3, causal_path_id: "docs/a.md" },
      ]);

      await client.query(
        `INSERT INTO "causal_citation_records" ("id", "workspace_id", "citation_id", "causal_path_id")
         VALUES ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'plain', 'docs/plain.md')`,
      );
      const plain = await client.query(
        `SELECT "fact_version", "causal_path_id"
           FROM "causal_citation_records"
          WHERE "citation_id" = 'plain'`,
      );
      expect(plain.rows).toEqual([{ fact_version: null, causal_path_id: "docs/plain.md" }]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      client.release();
    }
  },
);
