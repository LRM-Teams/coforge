export const WORKSPACE_MEMORY_PG_URL =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;

export const WORKSPACE_MEMORY_PROFILE_MIGRATION_SQL = await Bun.file(
  new URL(
    "../../prisma/migrations/20260921120000_workspace_memory_profiles/migration.sql",
    import.meta.url,
  ),
).text();

export function warnIfWorkspaceMemoryPgSkipped(label: string): void {
  if (WORKSPACE_MEMORY_PG_URL) return;
  console.warn(
    `${label} PostgreSQL tests not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL`,
  );
}

export type WorkspaceMemoryPgClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

const WORKSPACE_MEMORY_STUB_SQL = `
  CREATE TABLE "workspaces" ("id" UUID PRIMARY KEY);
  CREATE TABLE "causal_citation_records" (
    "id" UUID PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "citation_id" TEXT NOT NULL,
    "fact_version" INTEGER
  );
  CREATE UNIQUE INDEX "causal_citation_records_workspace_id_citation_id_key"
    ON "causal_citation_records"("workspace_id", "citation_id");
`;

export async function applyWorkspaceMemoryPgStub(
  client: WorkspaceMemoryPgClient,
  input: {
    workspaceIds: readonly string[];
    migrationSql?: string;
  },
): Promise<void> {
  await client.query(WORKSPACE_MEMORY_STUB_SQL);
  await client.query(input.migrationSql ?? WORKSPACE_MEMORY_PROFILE_MIGRATION_SQL);
  if (input.workspaceIds.length === 0) return;
  const values = input.workspaceIds.map((_, index) => `($${index + 1})`).join(", ");
  await client.query(`INSERT INTO "workspaces" VALUES ${values}`, [...input.workspaceIds]);
}
