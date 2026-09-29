import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { requireWorkspaceIdForSlug } from "#src/server/workspaces/selection.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const slugs = [`wu-ada-${suffix}`, `wu-grace-${suffix}`];
const usernames = [`wu-ada-${suffix}`, `wu-grace-${suffix}`];

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug: { in: slugs } } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("a Workspace named in the URL is the User's own or not found, never another one", async () => {
  const [ada, grace] = await Promise.all(
    usernames.map((username) => db.user.create({ data: { username } })),
  );
  const [adaWorkspace] = await Promise.all([
    db.workspace.create({
      data: { slug: slugs[0]!, name: "Ada", members: { create: { userId: ada!.id } } },
    }),
    db.workspace.create({
      data: { slug: slugs[1]!, name: "Grace", members: { create: { userId: grace!.id } } },
    }),
  ]);
  expect(await requireWorkspaceIdForSlug(db, ada!.id, slugs[0]!)).toBe(adaWorkspace.id);
  await expect(requireWorkspaceIdForSlug(db, ada!.id, slugs[1]!)).rejects.toEqual(
    new AppError("NOT_FOUND"),
  );
  await expect(requireWorkspaceIdForSlug(db, ada!.id, `missing-${suffix}`)).rejects.toEqual(
    new AppError("NOT_FOUND"),
  );
});
