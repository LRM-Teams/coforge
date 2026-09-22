import { afterAll, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;
const migration = await Bun.file(
  new URL("./migrations/20260921120000_workspace_memory_profiles/migration.sql", import.meta.url),
).text();

afterAll(async () => {
  await pool?.end();
});

const FORBIDDEN_CREDENTIAL_COLUMNS = [
  "credential",
  "credential_plaintext",
  "credentialPlaintext",
  "api_key",
  "apiKey",
  "plaintext",
  "token",
  "password",
];

test("workspace memory migration is additive and never stores credential plaintext", () => {
  expect(migration).toContain('CREATE TABLE "workspace_memory_profiles"');
  expect(migration).toContain('CREATE TABLE "openviking_bindings"');
  expect(migration).toContain('CREATE TABLE "openviking_mapped_identities"');
  expect(migration).toContain('CREATE TABLE "admitted_public_channel_segments"');
  expect(migration).toContain('CREATE TABLE "admitted_segment_source_messages"');
  expect(migration).toContain('CREATE TABLE "admitted_segment_dispatches"');
  expect(migration).toContain('CREATE TABLE "openviking_citation_records"');
  expect(migration).toContain('CREATE TABLE "memory_offer_records"');
  expect(migration).toContain('CREATE TABLE "memory_offer_citations"');
  expect(migration).toContain('CREATE TABLE "workspace_memory_cleanup_work"');
  expect(migration).not.toContain("DROP TABLE");
  expect(migration).not.toContain("causal_workspace_tenants");
  expect(migration).not.toContain("admitted_segment_ingest_ledgers");
  for (const column of FORBIDDEN_CREDENTIAL_COLUMNS) {
    expect(migration.includes(`"${column}"`)).toBe(false);
  }
  expect(migration).toContain('"credential_ref" TEXT NOT NULL');
  expect(migration).toContain("CHECK (\"credential_ref\" LIKE 'secret:%'");
});

test("workspace memory migration freezes C4 names and Workspace-scoped uniqueness", () => {
  expect(migration).toContain("CHECK (\"desired\" IN ('off', 'openviking', 'causal_openviking'))");
  expect(migration).toContain(
    "CHECK (\"observed\" IN ('provisioning', 'ready', 'degraded', 'switching', 'error'))",
  );
  expect(migration).toContain('"activation_cursor_kind"');
  expect(migration).toContain("CHECK (\"citation_kind\" IN ('openviking', 'causal_memory'))");
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "admitted_public_channel_segments_workspace_id_segment_id_key"',
  );
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "admitted_segment_source_messages_workspace_id_segment_id_me_key"',
  );
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "admitted_segment_dispatches_workspace_id_operation_id_key"',
  );
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "openviking_citation_records_workspace_id_citation_id_key"',
  );
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "memory_offer_citations_workspace_id_offer_operation_id_cita_key"',
  );
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "workspace_memory_cleanup_work_workspace_id_operation_id_tar_key"',
  );
  expect(migration).toContain("ON DELETE RESTRICT");
  expect(migration).toContain("admitted segment lineage is immutable");
});

async function createMigratedSchema() {
  const schema = `wmp_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool!.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE "workspaces" ("id" UUID PRIMARY KEY);
    CREATE TABLE "causal_citation_records" (
      "id" UUID PRIMARY KEY,
      "workspace_id" UUID NOT NULL,
      "citation_id" TEXT NOT NULL
    );
    CREATE UNIQUE INDEX "causal_citation_records_workspace_id_citation_id_key"
      ON "causal_citation_records"("workspace_id", "citation_id");
  `);
  await client.query(migration);
  return { client, schema };
}

async function dropSchema(schema: string) {
  const cleanup = await pool!.connect();
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    cleanup.release();
  }
}

if (!connectionString) {
  console.warn(
    "workspace-memory-profile PostgreSQL tests not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

test.skipIf(!connectionString)(
  "replay, workspace isolation, activation, citation kind, and cleanup retention hold",
  async () => {
    const { client, schema } = await createMigratedSchema();
    const workspaceA = "00000000-0000-0000-0000-00000000000a";
    const workspaceB = "00000000-0000-0000-0000-00000000000b";
    try {
      await client.query(`INSERT INTO "workspaces" VALUES ($1), ($2)`, [workspaceA, workspaceB]);

      await assertReplay(client, workspaceA);
      await assertWorkspaceIsolation(client, workspaceA, workspaceB);
      await assertActivationCursor(client, workspaceA);
      await assertCitationKindIntegrity(client, workspaceA, workspaceB);
      await assertCleanupRetention(client, workspaceA);
    } finally {
      client.release();
      await dropSchema(schema);
    }
  },
);

async function assertReplay(client: PoolClient, workspaceId: string) {
  await client.query(
    `INSERT INTO "admitted_public_channel_segments"
      ("id", "workspace_id", "segment_id", "channel_id", "kind", "conversation_kind",
       "source_payload_hash", "profile_generation", "closed_at")
     VALUES ($1, $2, 'seg-1', 'channel-1', 'completed_task', 'public_channel', 'hash-1', 1, '2026-09-21T00:00:01Z')`,
    ["10000000-0000-0000-0000-000000000001", workspaceId],
  );
  await expect(
    client.query(
      `INSERT INTO "admitted_public_channel_segments"
        ("id", "workspace_id", "segment_id", "channel_id", "kind", "conversation_kind",
         "source_payload_hash", "profile_generation", "closed_at")
       VALUES ($1, $2, 'seg-1', 'channel-1', 'quiet_window', 'public_channel', 'hash-other', 1, '2026-09-21T00:00:02Z')`,
      ["10000000-0000-0000-0000-000000000099", workspaceId],
    ),
  ).rejects.toThrow(/admitted_public_channel_segments_workspace_id_segment_id_key/);

  await client.query(
    `INSERT INTO "admitted_segment_source_messages"
      ("id", "workspace_id", "segment_id", "message_id", "payload_hash")
     VALUES ($1, $2, 'seg-1', 'msg-1', 'payload-1')`,
    ["20000000-0000-0000-0000-000000000001", workspaceId],
  );
  await expect(
    client.query(
      `UPDATE "admitted_segment_source_messages" SET "payload_hash" = 'mutated' WHERE "message_id" = 'msg-1'`,
    ),
  ).rejects.toThrow(/admitted segment lineage is immutable/);
  await expect(
    client.query(
      `UPDATE "admitted_public_channel_segments" SET "source_payload_hash" = 'mutated' WHERE "segment_id" = 'seg-1'`,
    ),
  ).rejects.toThrow(/admitted segment lineage is immutable/);

  await client.query(
    `INSERT INTO "admitted_segment_dispatches"
      ("id", "workspace_id", "segment_id", "operation_id", "sink_profile", "profile_generation",
       "state", "updated_at")
     VALUES ($1, $2, 'seg-1', 'op-1', 'openviking', 1, 'pending', CURRENT_TIMESTAMP)`,
    ["30000000-0000-0000-0000-000000000001", workspaceId],
  );
  await expect(
    client.query(
      `INSERT INTO "admitted_segment_dispatches"
        ("id", "workspace_id", "segment_id", "operation_id", "sink_profile", "profile_generation",
         "state", "updated_at")
       VALUES ($1, $2, 'seg-1', 'op-2', 'causal_openviking', 1, 'pending', CURRENT_TIMESTAMP)`,
      ["30000000-0000-0000-0000-000000000099", workspaceId],
    ),
  ).rejects.toThrow(/admitted_segment_dispatches_workspace_id_segment_id_key/);
}

async function assertWorkspaceIsolation(
  client: PoolClient,
  workspaceA: string,
  workspaceB: string,
) {
  await client.query(
    `INSERT INTO "admitted_public_channel_segments"
      ("id", "workspace_id", "segment_id", "channel_id", "kind", "conversation_kind",
       "source_payload_hash", "profile_generation", "closed_at")
     VALUES ($1, $2, 'seg-1', 'channel-b', 'quiet_window', 'public_channel', 'hash-b', 3, '2026-09-21T00:00:03Z')`,
    ["10000000-0000-0000-0000-00000000000b", workspaceB],
  );
  const isolated = await client.query(
    `SELECT "workspace_id"::text, "source_payload_hash"
       FROM "admitted_public_channel_segments"
      WHERE "segment_id" = 'seg-1'
      ORDER BY "workspace_id"`,
  );
  expect(isolated.rows).toEqual([
    { workspace_id: workspaceA, source_payload_hash: "hash-1" },
    { workspace_id: workspaceB, source_payload_hash: "hash-b" },
  ]);

  const workspaceC = "00000000-0000-0000-0000-00000000000c";
  await client.query(`INSERT INTO "workspaces" VALUES ($1)`, [workspaceC]);
  await client.query(
    `INSERT INTO "openviking_bindings"
      ("workspace_id", "account_id", "service_identity_id", "credential_ref", "generation", "updated_at")
     VALUES ($1, 'acct-a', 'svc-a', 'secret:ov-a', 1, CURRENT_TIMESTAMP),
            ($2, 'acct-b', 'svc-b', 'secret:ov-b', 1, CURRENT_TIMESTAMP)`,
    [workspaceA, workspaceB],
  );
  await expect(
    client.query(
      `INSERT INTO "openviking_bindings"
        ("workspace_id", "account_id", "service_identity_id", "credential_ref", "generation", "updated_at")
       VALUES ($1, 'acct-a', 'svc-dup', 'secret:ov-dup', 2, CURRENT_TIMESTAMP)`,
      [workspaceC],
    ),
  ).rejects.toThrow(/openviking_bindings_account_id_key/);
}

async function assertActivationCursor(client: PoolClient, workspaceId: string) {
  await client.query(
    `INSERT INTO "workspace_memory_profiles"
      ("workspace_id", "desired", "observed", "generation",
       "activation_cursor_kind", "activation_occurred_at", "updated_at")
     VALUES ($1, 'openviking', 'ready', 1, 'time', '2026-09-21T00:00:00Z', CURRENT_TIMESTAMP)`,
    [workspaceId],
  );
  await client.query(
    `UPDATE "workspace_memory_profiles"
        SET "desired" = 'causal_openviking',
            "observed" = 'switching',
            "generation" = 2,
            "activation_cursor_kind" = 'message',
            "activation_occurred_at" = '2026-09-21T00:01:00Z',
            "activation_message_id" = 'msg-activate',
            "reconcile_kind" = 'switch'
      WHERE "workspace_id" = $1`,
    [workspaceId],
  );
  const stored = await client.query(
    `SELECT "desired", "observed", "generation", "activation_cursor_kind", "activation_message_id"
       FROM "workspace_memory_profiles" WHERE "workspace_id" = $1`,
    [workspaceId],
  );
  expect(stored.rows).toEqual([
    {
      desired: "causal_openviking",
      observed: "switching",
      generation: 2,
      activation_cursor_kind: "message",
      activation_message_id: "msg-activate",
    },
  ]);

  await expect(
    client.query(
      `UPDATE "workspace_memory_profiles"
          SET "activation_cursor_kind" = 'time', "activation_message_id" = 'stale'
        WHERE "workspace_id" = $1`,
      [workspaceId],
    ),
  ).rejects.toThrow(/workspace_memory_profiles_activation_cursor_check/);
  await expect(
    client.query(
      `UPDATE "workspace_memory_profiles" SET "desired" = 'causal-memory' WHERE "workspace_id" = $1`,
      [workspaceId],
    ),
  ).rejects.toThrow(/workspace_memory_profiles_desired_check/);
}

async function assertCitationKindIntegrity(
  client: PoolClient,
  workspaceA: string,
  workspaceB: string,
) {
  await client.query(
    `INSERT INTO "openviking_citation_records"
      ("id", "workspace_id", "citation_id", "account_id", "uri", "content_hash",
       "matched_level", "title", "bound_operation_id")
     VALUES ($1, $2, 'ov-1', 'acct-a', 'viking://fact/1', 'hash-ov', 'L2', 'Fact one', 'read-1')`,
    ["40000000-0000-0000-0000-000000000001", workspaceA],
  );
  await client.query(
    `INSERT INTO "causal_citation_records" ("id", "workspace_id", "citation_id")
     VALUES ($1, $2, 'cm-1')`,
    ["50000000-0000-0000-0000-000000000001", workspaceA],
  );
  await client.query(
    `INSERT INTO "memory_offer_records"
      ("id", "workspace_id", "operation_id", "conversation_id", "recipient_agent_id",
       "recipient_rationale", "message_id")
     VALUES ($1, $2, 'offer-1', 'conv-1', 'agent-1', 'owns the task', 'msg-offer')`,
    ["60000000-0000-0000-0000-000000000001", workspaceA],
  );
  await client.query(
    `INSERT INTO "memory_offer_citations"
      ("id", "workspace_id", "offer_operation_id", "citation_kind", "citation_id", "openviking_citation_id")
     VALUES ($1, $2, 'offer-1', 'openviking', 'ov-1', 'ov-1')`,
    ["70000000-0000-0000-0000-000000000001", workspaceA],
  );
  await client.query(
    `INSERT INTO "memory_offer_citations"
      ("id", "workspace_id", "offer_operation_id", "citation_kind", "citation_id", "causal_citation_id")
     VALUES ($1, $2, 'offer-1', 'causal_memory', 'cm-1', 'cm-1')`,
    ["70000000-0000-0000-0000-000000000002", workspaceA],
  );

  await expect(
    client.query(
      `INSERT INTO "memory_offer_citations"
        ("id", "workspace_id", "offer_operation_id", "citation_kind", "citation_id", "causal_citation_id")
       VALUES ($1, $2, 'offer-1', 'causal_memory', 'ov-1', 'ov-1')`,
      ["70000000-0000-0000-0000-000000000099", workspaceA],
    ),
  ).rejects.toThrow(
    /memory_offer_citations_typed_ref_check|memory_offer_citations_causal_citation_fkey/,
  );
  await expect(
    client.query(
      `INSERT INTO "memory_offer_citations"
        ("id", "workspace_id", "offer_operation_id", "citation_kind", "citation_id",
         "openviking_citation_id", "causal_citation_id")
       VALUES ($1, $2, 'offer-1', 'openviking', 'ov-1', 'ov-1', 'cm-1')`,
      ["70000000-0000-0000-0000-000000000098", workspaceA],
    ),
  ).rejects.toThrow(/memory_offer_citations_typed_ref_check/);

  await client.query(
    `INSERT INTO "openviking_citation_records"
      ("id", "workspace_id", "citation_id", "account_id", "uri", "content_version",
       "matched_level", "excerpt", "bound_operation_id")
     VALUES ($1, $2, 'ov-1', 'acct-b', 'viking://fact/other', 'v2', 'L0', 'other', 'read-b')`,
    ["40000000-0000-0000-0000-00000000000b", workspaceB],
  );
  const foreign = await client.query(
    `SELECT "account_id" FROM "openviking_citation_records"
      WHERE "workspace_id" = $1 AND "citation_id" = 'ov-1'`,
    [workspaceB],
  );
  expect(foreign.rows).toEqual([{ account_id: "acct-b" }]);
}

async function assertCleanupRetention(client: PoolClient, workspaceId: string) {
  await client.query(
    `INSERT INTO "workspace_memory_cleanup_work"
      ("id", "workspace_id", "operation_id", "target", "state", "attempt_count",
       "sanitized_error", "updated_at")
     VALUES ($1, $2, 'cleanup-1', 'openviking_account', 'leased', 1, NULL, CURRENT_TIMESTAMP)`,
    ["80000000-0000-0000-0000-000000000001", workspaceId],
  );
  await client.query(
    `UPDATE "workspace_memory_cleanup_work"
        SET "state" = 'retryable_failure',
            "attempt_count" = 2,
            "sanitized_error" = 'openviking account delete failed',
            "lease_owner" = NULL
      WHERE "workspace_id" = $1 AND "operation_id" = 'cleanup-1' AND "target" = 'openviking_account'`,
    [workspaceId],
  );
  const retained = await client.query(
    `SELECT "state", "attempt_count", "sanitized_error"
       FROM "workspace_memory_cleanup_work"
      WHERE "workspace_id" = $1 AND "target" = 'openviking_account'`,
    [workspaceId],
  );
  expect(retained.rows).toEqual([
    {
      state: "retryable_failure",
      attempt_count: 2,
      sanitized_error: "openviking account delete failed",
    },
  ]);
  await expect(
    client.query(`DELETE FROM "workspaces" WHERE "id" = $1`, [workspaceId]),
  ).rejects.toThrow(/workspace_memory_cleanup_work_workspace_id_fkey/);
  await expect(
    client.query(
      `UPDATE "openviking_bindings" SET "credential_ref" = 'not-a-secret' WHERE "workspace_id" = $1`,
      [workspaceId],
    ),
  ).rejects.toThrow(/openviking_bindings_credential_ref_check/);
}
