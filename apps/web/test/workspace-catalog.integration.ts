import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { workspaceIconUrl } from "#src/server/workspaces/workspace-images.server";

test("renaming a Workspace stores the new name for every member and keeps its slug and icon", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const store = new PrismaWorkspaceCatalogStore(db);
  try {
    const [owner, member] = await Promise.all(
      ["owner", "member"].map((name) =>
        db.user.create({ data: { username: `workspace-rename-${name}-${suffix}` } }),
      ),
    );
    const iconObjectKey = `workspaces/rename-${suffix}/icons/${suffix}/original`;
    const [workspace, other] = await Promise.all(
      ["renamed", "untouched"].map((label) =>
        db.workspace.create({
          data: {
            slug: `workspace-${label}-${suffix}`,
            name: label,
            ...(label === "renamed" && { iconObjectKey, iconContentType: "image/png" }),
            members: {
              create: [
                { userId: owner!.id, role: "owner" },
                { userId: member!.id, role: "member" },
              ],
            },
          },
        }),
      ),
    );

    const renamed = await new WorkspaceCatalog(store).rename(
      workspace!.id,
      "owner",
      "  Research Lab  ",
    );

    const expected = {
      id: workspace!.id,
      slug: workspace!.slug,
      name: "Research Lab",
      iconUrl: workspaceIconUrl(workspace!.id, iconObjectKey),
    };
    expect(renamed).toEqual(expected);
    const listed = await store.listForUser(member!.id);
    expect(listed.find((row) => row.id === workspace!.id)).toEqual(expected);
    expect(listed.find((row) => row.id === other!.id)?.name).toBe("untouched");
  } finally {
    // Setup may have stopped part way, so clean up by the run's suffix rather than by created rows.
    await db.workspace.deleteMany({ where: { slug: { endsWith: suffix } } });
    await db.user.deleteMany({ where: { username: { endsWith: suffix } } });
    await db.$disconnect();
  }
});
