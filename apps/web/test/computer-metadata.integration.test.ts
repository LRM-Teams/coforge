import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { recordComputerObservation } from "../src/server/computers/computer-metadata.server";
import { handleComputerCreatorAvatar } from "../src/server/computers/computer-creator-avatar.server";

const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "Computer observations persist, preserve unknown fields, and reject stale or wrong-scope writes",
  async () => {
    const pool = new Pool({ connectionString });
    const schema = `computer_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
    const computerId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE computers (id UUID PRIMARY KEY, "ownerId" UUID NOT NULL);
      CREATE TABLE workspace_computers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "computerId" UUID NOT NULL, "workspaceId" UUID NOT NULL);
      CREATE TABLE workspaces (id UUID PRIMARY KEY);
      CREATE TABLE workspace_memberships ("workspaceId" UUID NOT NULL, "userId" UUID NOT NULL);`);
      await client.query(`INSERT INTO computers VALUES ($1, $2)`, [computerId, ownerId]);
      await client.query(
        `INSERT INTO workspace_computers ("computerId", "workspaceId") VALUES ($1, $2)`,
        [computerId, workspaceId],
      );
      await client.query(
        await Bun.file(
          new URL(
            "../prisma/migrations/20260909120000_computer_observed_metadata/migration.sql",
            import.meta.url,
          ),
        ).text(),
      );
      const read = () =>
        db.computer.findUniqueOrThrow({
          where: { id: computerId },
          select: { ownerId: true, computerVersion: true, platform: true, osVersion: true },
        });
      expect(await read()).toEqual({
        ownerId,
        computerVersion: null,
        platform: null,
        osVersion: null,
      });
      await recordComputerObservation(
        db,
        { workspaceId, computerId },
        { startedAt: 20, computerVersion: "4.5.6", platform: "darwin", osVersion: "26.1" },
      );
      await recordComputerObservation(db, { workspaceId, computerId }, { startedAt: 21 });
      await recordComputerObservation(
        db,
        { workspaceId, computerId },
        { startedAt: 19, computerVersion: "old", platform: "linux", osVersion: "6.0" },
      );
      await recordComputerObservation(
        db,
        { workspaceId: crypto.randomUUID(), computerId },
        { startedAt: 99, computerVersion: "wrong-workspace" },
      );
      expect(await read()).toEqual({
        ownerId,
        computerVersion: "4.5.6",
        platform: "darwin",
        osVersion: "26.1",
      });
      await recordComputerObservation(
        db,
        { workspaceId, computerId },
        { startedAt: 22, computerVersion: "4.5.7", osVersion: "" },
      );
      expect(await read()).toEqual({
        ownerId,
        computerVersion: "4.5.7",
        platform: "darwin",
        osVersion: "26.1",
      });
      const viewerId = crypto.randomUUID();
      await client.query(`INSERT INTO workspaces VALUES ($1)`, [workspaceId]);
      await client.query(`INSERT INTO workspace_memberships VALUES ($1, $2)`, [
        workspaceId,
        viewerId,
      ]);
      const request = new Request(
        `https://coforge.test/api/computers/${computerId}/creator-avatar?workspaceId=${workspaceId}`,
      );
      const dependencies = {
        authenticate: () => ({ id: viewerId }),
        database: () => db,
        read: async (_db: PrismaClient, userId: string) => {
          expect(userId).toBe(ownerId);
          return { body: new Blob(["creator-image"]), contentType: "image/png" };
        },
      };
      const image = await handleComputerCreatorAvatar(request, computerId, dependencies);
      expect(image.status).toBe(200);
      expect(await image.text()).toBe("creator-image");
      await client.query(`DELETE FROM workspace_memberships WHERE "userId" = $1`, [viewerId]);
      expect((await handleComputerCreatorAvatar(request, computerId, dependencies)).status).toBe(
        404,
      );
    } finally {
      await db.$disconnect();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
