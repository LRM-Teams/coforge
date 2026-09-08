import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/client";
import { AgentSessions } from "../src/server/agents/agent-sessions.server";
import { PrismaAgentSessionRepository } from "../src/server/db/repositories/agent-session.repositories.server";

const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "PostgreSQL session migration and fenced reference survive a new repository",
  async () => {
    const pool = new Pool({ connectionString });
    const schema = `session_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE agents (
      id UUID PRIMARY KEY, "workspaceId" UUID NOT NULL, name TEXT NOT NULL,
      "displayName" TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL,
      "ownerId" UUID NOT NULL, "computerId" UUID, "runtimeConfig" JSONB NOT NULL,
      UNIQUE (id, "workspaceId"))`);
      await client.query(
        await Bun.file(
          new URL(
            "../prisma/migrations/20260908040000_agent_runtime_session/migration.sql",
            import.meta.url,
          ),
        ).text(),
      );
      await client.query(
        await Bun.file(
          new URL(
            "../prisma/migrations/20260908120000_agent_session_binding/migration.sql",
            import.meta.url,
          ),
        ).text(),
      );
      const legacyAgentId = crypto.randomUUID();
      const legacyWorkspaceId = crypto.randomUUID();
      const reassignedComputerId = crypto.randomUUID();
      const storedComputerId = crypto.randomUUID();
      await client.query(
        `INSERT INTO agents
          (id, "workspaceId", name, "displayName", "createdAt", "ownerId", "computerId", "runtimeConfig", "runtimeSession")
         VALUES ($1, $2, 'legacy', 'Legacy', NOW(), $3, $4, $5, $6)`,
        [
          legacyAgentId,
          legacyWorkspaceId,
          crypto.randomUUID(),
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
      await client.query(
        await Bun.file(
          new URL(
            "../prisma/migrations/20260908130000_backfill_agent_session_binding/migration.sql",
            import.meta.url,
          ),
        ).text(),
      );
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
      const agentId = crypto.randomUUID(),
        workspaceId = crypto.randomUUID(),
        computerId = crypto.randomUUID();
      await db.agent.create({
        data: {
          id: agentId,
          workspaceId,
          computerId,
          ownerId: crypto.randomUUID(),
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
      const delayed = new AgentSessions(new PrismaAgentSessionRepository(db), async () => {
        entered.resolve();
        await release.promise;
        return "replacement-daemon";
      });
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
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
