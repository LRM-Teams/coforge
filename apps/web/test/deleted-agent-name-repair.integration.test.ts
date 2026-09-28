import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

/**
 * Runs the migration that repairs deleted Agents renamed to `<name>-deleted-<uuid>` while that
 * was the rename format, against local PostgreSQL. Such a name can exceed the 60-character
 * sender-handle bound, which makes every history read that includes the deleted Agent's messages
 * fail. Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20260924143000_repair_overlong_deleted_agent_names/migration.sql",
    import.meta.url,
  ),
).text();

test.skipIf(!connectionString)(
  "the repair shortens an over-long deleted Agent name and leaves every other name alone",
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({ data: { username: `repair-owner-${suffix}` } });
    const workspace = await db.workspace.create({
      data: { slug: `repair-${suffix}`, name: "Name repair" },
    });
    const runtimeConfig = {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    };
    const agent = (name: string, deletedAt: Date | null) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          name,
          displayName: name,
          ownerId: owner.id,
          runtimeConfig,
          deletedAt,
        },
      });
    try {
      const longId = crypto.randomUUID();
      const long = await agent(
        `release-coordinator-${suffix}-aaaaaaaaa-tail-deleted-${longId}`,
        new Date(),
      );
      const short = await agent(`bot-${suffix}-deleted-${crypto.randomUUID()}`, new Date());
      const live = await agent(`live-agent-${suffix}-deleted-${crypto.randomUUID()}`, null);
      expect(long.name.length).toBeGreaterThan(60);
      expect(short.name.length).toBeLessThanOrEqual(60);
      expect(live.name.length).toBeGreaterThan(60);

      await db.$executeRawUnsafe(migration);

      const names = new Map(
        (
          await db.agent.findMany({
            where: { id: { in: [long.id, short.id, live.id] } },
            select: { id: true, name: true },
          })
        ).map((row) => [row.id, row.name]),
      );
      // The first 39 characters of the original name end in a hyphen, which is trimmed; then the
      // current format.
      expect(names.get(long.id)).toBe(
        `release-coordinator-${suffix}-aaaaaaaaa-deleted-${long.id.replaceAll("-", "").slice(0, 12)}`,
      );
      expect(names.get(long.id)!.length).toBeLessThanOrEqual(60);
      expect(names.get(short.id)).toBe(short.name);
      expect(names.get(live.id)).toBe(live.name);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.delete({ where: { id: owner.id } }).catch(() => {});
      await db.$disconnect();
    }
  },
);
