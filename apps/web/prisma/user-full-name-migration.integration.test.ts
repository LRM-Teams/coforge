import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { Pool } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationName = (await readdir(migrationsDirectory)).find((name) =>
  name.endsWith("_user_full_name"),
);
const migration = migrationName
  ? await Bun.file(new URL(`${migrationName}/migration.sql`, migrationsDirectory)).text()
  : "";

afterAll(async () => {
  await pool?.end();
});

/**
 * `User.fullName` arrives with the name people have already given: a `displayName` was the
 * override name, so every existing one is copied to the full name and stays as the nickname, which
 * labels exactly as before. A user who set none, or only blank space, stays unnamed, and so does one
 * whose "name" is their own username: an older description-only save stored the fallback label
 * there, and it is not a name they gave.
 */
test("the migration exists and adds the nullable column", () => {
  expect(migrationName).toBeDefined();
  expect(migration).toMatch(/ADD COLUMN\s+"fullName" TEXT/);
  expect(migration).not.toMatch(/ADD COLUMN[^;]*NOT NULL/);
  expect(migration).not.toContain("DROP");
});

if (!connectionString) {
  console.warn(
    "user full name migration test not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

test.skipIf(!connectionString)(
  "an existing displayName is copied to the full name and kept, unless it is only the username",
  async () => {
    const schema = `ufn_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "username" TEXT NOT NULL, "displayName" TEXT)`,
      );
      await client.query(
        `INSERT INTO "users" ("id", "username", "displayName") VALUES
           ('named', 'ada', 'Ada Lovelace'),
           ('padded', 'grace', '  Grace Hopper  '),
           ('cjk', 'andong', '安栋'),
           ('blank', 'blank', '   '),
           ('frozen', 'ada2', 'ada2'),
           ('frozenpad', 'bob2', '  bob2  '),
           ('cased', 'carol', 'Carol'),
           ('empty', 'empty', ''),
           ('unnamed', 'user', NULL)`,
      );

      await client.query(migration);

      const rows = await client.query(
        `SELECT "id", "username", "fullName", "displayName" FROM "users" ORDER BY "id"`,
      );
      expect(rows.rows).toEqual([
        { id: "blank", username: "blank", fullName: null, displayName: "   " },
        { id: "cased", username: "carol", fullName: "Carol", displayName: "Carol" },
        { id: "cjk", username: "andong", fullName: "安栋", displayName: "安栋" },
        { id: "empty", username: "empty", fullName: null, displayName: "" },
        { id: "frozen", username: "ada2", fullName: null, displayName: null },
        { id: "frozenpad", username: "bob2", fullName: null, displayName: null },
        { id: "named", username: "ada", fullName: "Ada Lovelace", displayName: "Ada Lovelace" },
        {
          id: "padded",
          username: "grace",
          fullName: "Grace Hopper",
          displayName: "  Grace Hopper  ",
        },
        { id: "unnamed", username: "user", fullName: null, displayName: null },
      ]);
    } finally {
      client.release();
      const cleanup = await pool!.connect();
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        cleanup.release();
      }
    }
  },
);
