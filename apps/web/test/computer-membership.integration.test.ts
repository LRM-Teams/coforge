import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { isWorkspaceMemberComputer } from "../src/server/computers/computer-membership.server";

const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;
// Runs the real query: the defect this guards against was a relation name Prisma only rejects at
// request time, which no fake database would have caught.
test.skipIf(!connectionString)(
  "a Computer is available to Workspace members only, through the Workspace it is connected to",
  async () => {
    const pool = new Pool({ connectionString });
    const schema = `computer_member_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
    const [workspaceId, otherWorkspaceId, computerId, memberId, strangerId] = Array.from(
      { length: 5 },
      () => crypto.randomUUID(),
    );
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY);
      CREATE TABLE workspace_computers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "computerId" UUID NOT NULL, "workspaceId" UUID NOT NULL);
      CREATE TABLE workspace_memberships ("workspaceId" UUID NOT NULL, "userId" UUID NOT NULL);`);
      await client.query(`INSERT INTO workspaces VALUES ($1), ($2)`, [
        workspaceId,
        otherWorkspaceId,
      ]);
      await client.query(
        `INSERT INTO workspace_computers ("computerId", "workspaceId") VALUES ($1, $2)`,
        [computerId, workspaceId],
      );
      await client.query(`INSERT INTO workspace_memberships VALUES ($1, $2), ($3, $4)`, [
        workspaceId,
        memberId,
        otherWorkspaceId,
        strangerId,
      ]);

      expect(
        await isWorkspaceMemberComputer(db, { userId: memberId, workspaceId, computerId }),
      ).toBe(true);
      expect(
        await isWorkspaceMemberComputer(db, { userId: strangerId, workspaceId, computerId }),
      ).toBe(false);
      // A member of another Workspace cannot reach the Computer through their own Workspace.
      expect(
        await isWorkspaceMemberComputer(db, {
          userId: strangerId,
          workspaceId: otherWorkspaceId,
          computerId,
        }),
      ).toBe(false);
    } finally {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);
