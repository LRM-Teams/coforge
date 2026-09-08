import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
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
      "ownerId" UUID NOT NULL, "computerId" UUID, "runtimeConfig" JSONB NOT NULL)`);
      await client.query(
        await Bun.file(
          new URL(
            "../prisma/migrations/20260908040000_agent_runtime_session/migration.sql",
            import.meta.url,
          ),
        ).text(),
      );
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
      const recreated = new AgentSessions(
        new PrismaAgentSessionRepository(db),
        async () => "replacement-daemon",
      );
      expect((await recreated.prepare({ ...intent, requestId: "new-start" })).sessionId).toBe(
        "persisted-thread",
      );
      await expect(sessions.accept({ ...report, sessionId: "stale-thread" })).rejects.toThrow();
      await db.agent.update({
        where: { id: agentId },
        data: {
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
