import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AgentSessions } from "#src/server/agents/agent-sessions.server";
import { PrismaAgentSessionRepository } from "#src/server/db/repositories/agent-session.repositories.server";

/**
 * Builds a scratch database from the committed migrations, in deploy order: every migration
 * before the session backfill, then a legacy Agent row, then the backfill, then the rest. The
 * Agent tables are therefore always the ones `prisma migrate deploy` creates, so a new column
 * cannot leave this suite behind. Skipped unless `MIGRATION_TEST_DATABASE_URL` points at local
 * PostgreSQL; its role needs CREATEDB, since each run creates and drops its own database.
 */
const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const backfill = migrations.indexOf("20260908130000_backfill_agent_session_binding");

async function applyMigrations(client: PoolClient, names: readonly string[]) {
  for (const name of names) {
    await client.query(
      await Bun.file(new URL(`${name}/migration.sql`, migrationsDirectory)).text(),
    );
  }
}

test.skipIf(!connectionString)(
  "PostgreSQL session migration and fenced reference survive a new repository",
  async () => {
    const admin = new Pool({ connectionString });
    const database = `session_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const scratchUrl = new URL(connectionString!);
    scratchUrl.pathname = `/${database}`;
    const pool = new Pool({ connectionString: scratchUrl.href });
    const client = await pool.connect();
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: scratchUrl.href }) });
    try {
      expect(backfill).toBeGreaterThan(0);
      await applyMigrations(client, migrations.slice(0, backfill));
      const legacyAgentId = crypto.randomUUID();
      const legacyWorkspaceId = crypto.randomUUID();
      const legacyOwnerId = crypto.randomUUID();
      const reassignedComputerId = crypto.randomUUID();
      const storedComputerId = crypto.randomUUID();
      // The parents the legacy Agent's foreign keys need, as those tables stood before the backfill.
      await client.query(`INSERT INTO users (id, username) VALUES ($1, 'legacy-owner')`, [
        legacyOwnerId,
      ]);
      await client.query(
        `INSERT INTO workspaces (id, slug, name, "updatedAt") VALUES ($1, 'legacy', 'Legacy', NOW())`,
        [legacyWorkspaceId],
      );
      await client.query(
        `INSERT INTO computers (id, "ownerId", "machineId") VALUES ($1, $2, 'legacy-machine')`,
        [reassignedComputerId, legacyOwnerId],
      );
      await client.query(
        `INSERT INTO agents
          (id, "workspaceId", name, "displayName", "createdAt", "ownerId", "computerId", "runtimeConfig", "runtimeSession")
         VALUES ($1, $2, 'legacy', 'Legacy', NOW(), $3, $4, $5, $6)`,
        [
          legacyAgentId,
          legacyWorkspaceId,
          legacyOwnerId,
          reassignedComputerId,
          { runtime: "pi" },
          {
            provider: "codex",
            computerId: storedComputerId,
            sessionId: "legacy-native",
            state: "resumable",
            startRequestId: "legacy-start",
            daemonInstanceId: "legacy-daemon",
          },
        ],
      );
      await applyMigrations(client, [migrations[backfill]!]);
      const migrated = await client.query(
        `SELECT a."runtimeSession", s."computerId", s.provider, s."nativeSessionId"
         FROM agents a JOIN agent_sessions s ON s.id = a."currentSessionId"
         WHERE a.id = $1`,
        [legacyAgentId],
      );
      expect(migrated.rows).toEqual([
        {
          runtimeSession: {
            provider: "codex",
            computerId: storedComputerId,
            startRequestId: "legacy-start",
            daemonInstanceId: "legacy-daemon",
          },
          computerId: storedComputerId,
          provider: "codex",
          nativeSessionId: "legacy-native",
        },
      ]);
      await applyMigrations(client, migrations.slice(backfill + 1));
      const owner = await db.user.create({ data: { username: "session-owner" } });
      const { id: workspaceId } = await db.workspace.create({
        data: { slug: "session", name: "Session" },
      });
      const { id: computerId } = await db.computer.create({
        data: { ownerId: owner.id, machineId: "session-machine" },
      });
      const agentId = crypto.randomUUID();
      await db.agent.create({
        data: {
          id: agentId,
          workspaceId,
          computerId,
          ownerId: owner.id,
          name: "session-test",
          displayName: "Session",
          runtimeConfig: {
            runtime: "codex",
            provider: { kind: "default" },
            model: "m",
            reasoning: "r",
          },
        },
      });
      const sessions = new AgentSessions(
        new PrismaAgentSessionRepository(db),
        async () => "daemon",
        { resendForCurrentSession: async () => {} },
      );
      const intent = {
        protocolMajor: 1,
        requestId: "start",
        workspaceId,
        computerId,
        agentId,
        provider: "codex" as const,
        model: "m",
        reasoning: "r",
      };
      await sessions.prepare(intent);
      const report = {
        ...intent,
        requestId: "report",
        startRequestId: "start",
        daemonInstanceId: "daemon",
        launchId: "launch",
        sessionId: "persisted-thread",
      };
      await sessions.accept(report);
      await sessions.accept(report);
      expect(await db.agentSession.count({ where: { agentId } })).toBe(1);
      const persisted = await db.agent.findUniqueOrThrow({
        where: { id: agentId },
        include: { currentSession: true },
      });
      expect(persisted.runtimeSession).not.toHaveProperty("sessionId");
      expect(persisted.runtimeSession).not.toHaveProperty("state");
      expect(persisted.currentSession?.nativeSessionId).toBe("persisted-thread");
      const recreated = new AgentSessions(
        new PrismaAgentSessionRepository(db),
        async () => "replacement-daemon",
        { resendForCurrentSession: async () => {} },
      );
      expect((await recreated.prepare({ ...intent, requestId: "new-start" })).sessionId).toBe(
        "persisted-thread",
      );
      await expect(sessions.accept({ ...report, sessionId: "stale-thread" })).rejects.toThrow();
      // A control operation fences the prior launch before a known-empty Start.
      const controlState = {
        ...intent,
        version: 1,
        epoch: 2,
        action: "start",
        phase: "starting",
        requestId: "empty-start",
        launchId: "empty-launch",
        configRevision: "test",
        controlSequence: 0,
        sessionSequence: 0,
      };
      await db.agent.update({
        where: { id: agentId },
        data: { runtimeSession: Prisma.DbNull, controlState },
      });
      await db.agentSession.update({
        where: { id: persisted.currentSession!.id },
        data: { state: "empty" },
      });
      const emptyStart = await recreated.prepare({
        ...intent,
        requestId: "empty-start",
        controlEpoch: 2,
      });
      expect(emptyStart.sessionId).toBeUndefined();
      await recreated.accept({
        ...report,
        startRequestId: "empty-start",
        daemonInstanceId: "replacement-daemon",
        sessionId: "fresh-after-empty",
        launchId: "empty-launch",
        controlEpoch: 2,
      });
      expect(
        (
          await db.agent.findUniqueOrThrow({
            where: { id: agentId },
            include: { currentSession: true },
          })
        ).currentSession?.nativeSessionId,
      ).toBe("fresh-after-empty");
      await db.agent.update({ where: { id: agentId }, data: { runtimeSession: Prisma.DbNull } });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delayed = new AgentSessions(
        new PrismaAgentSessionRepository(db),
        async () => {
          entered.resolve();
          await release.promise;
          return "replacement-daemon";
        },
        { resendForCurrentSession: async () => {} },
      );
      const oldStart = delayed.prepare({ ...intent, requestId: "empty-start", controlEpoch: 2 });
      try {
        await entered.promise;
        await db.agent.update({
          where: { id: agentId },
          data: {
            controlState: {
              ...controlState,
              requestId: "newer-reset",
              epoch: 3,
              phase: "stopping",
            },
          },
        });
        release.resolve();
        await expect(oldStart).rejects.toThrow("changed concurrently");
        expect(
          (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).runtimeSession,
        ).toBeNull();
      } finally {
        release.resolve();
        await Promise.allSettled([oldStart]);
      }
      await db.agent.update({
        where: { id: agentId },
        data: {
          controlState: Prisma.DbNull,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "m",
            reasoning: "r",
          },
        },
      });
      expect(
        (await recreated.prepare({ ...intent, requestId: "pi-start", provider: "pi" })).sessionId,
      ).toBeUndefined();
    } finally {
      await db.$disconnect();
      client.release();
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
