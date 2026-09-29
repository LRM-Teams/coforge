import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { FileStorage } from "#src/server/files/file-storage.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { WorkspaceImages } from "#src/server/workspaces/workspace-images.server";

test("a Workspace icon is set by an owner or admin, replaced atomically, and readable by members", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const [owner, admin, member, outsider] = await Promise.all(
    ["owner", "admin", "member", "outsider"].map((name) =>
      db.user.create({ data: { username: `workspace-icon-${name}-${suffix}` } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `workspace-icon-${suffix}`,
      name: "Icons",
      members: {
        create: [
          { userId: owner!.id, role: "owner" },
          { userId: admin!.id, role: "admin" },
          { userId: member!.id, role: "member" },
        ],
      },
    },
  });
  const objects = new Map<string, Blob>();
  const storage: FileStorage = {
    put: async (key, file) => {
      objects.set(key, file);
    },
    open: async (key) => {
      const body = objects.get(key);
      return body ? { body, contentType: body.type, sizeBytes: body.size } : null;
    },
    remove: async (key) => {
      objects.delete(key);
    },
    head: async (key) => {
      const body = objects.get(key);
      return body ? { sizeBytes: body.size, contentType: body.type || null } : null;
    },
  };
  const images = new WorkspaceImages(db, async () => storage);
  const png = (byte: number) =>
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, byte])], "icon.png", {
      type: "image/png",
    });
  const bytesOf = async (userId: string) =>
    new Response((await images.read(userId, workspace.id)).body).bytes();
  try {
    await expect(images.store(workspace.id, member!.id, png(1))).rejects.toThrow("ACCESS_DENIED");
    await expect(images.store(workspace.id, outsider!.id, png(1))).rejects.toThrow("ACCESS_DENIED");
    for (const file of [
      new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }),
      new File(["not a png"], "icon.png", { type: "image/png" }),
      new File([], "empty.png", { type: "image/png" }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    ])
      await expect(images.store(workspace.id, owner!.id, file)).rejects.toThrow("INVALID_INPUT");
    expect(objects.size).toBe(0);
    await expect(images.read(member!.id, workspace.id)).rejects.toThrow("NOT_FOUND");

    const first = await images.store(workspace.id, owner!.id, png(1));
    expect(first.iconUrl).toStartWith(`/api/workspaces/${workspace.id}/icon?v=`);
    expect(await bytesOf(member!.id)).toEqual(new Uint8Array(await png(1).arrayBuffer()));
    expect((await images.read(member!.id, workspace.id)).contentType).toBe("image/png");
    await expect(images.read(outsider!.id, workspace.id)).rejects.toThrow("NOT_FOUND");
    const listed = await new PrismaWorkspaceCatalogStore(db).listForUser(member!.id);
    expect(listed.find((row) => row.id === workspace.id)?.iconUrl).toBe(first.iconUrl);

    const previousKey = [...objects.keys()][0];
    const second = await images.store(workspace.id, admin!.id, png(2));
    expect(second.iconUrl).not.toBe(first.iconUrl);
    expect(objects.size).toBe(1);
    expect(objects.has(previousKey!)).toBeFalse();
    expect(await bytesOf(owner!.id)).toEqual(new Uint8Array(await png(2).arrayBuffer()));

    const put = storage.put;
    const uploaded = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const demoted = Promise.withResolvers<void>();
    try {
      let arrivals = 0;
      storage.put = async (key, file, type) => {
        await put(key, file, type);
        if (++arrivals === 2) uploaded.resolve();
        await uploaded.promise;
      };
      const replacements = await Promise.allSettled([
        images.store(workspace.id, owner!.id, png(3)),
        images.store(workspace.id, admin!.id, png(4)),
      ]);
      expect(replacements.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const lost = replacements.find((result) => result.status === "rejected");
      expect(lost?.reason).toEqual(new AppError("CONFLICT"));
      expect(objects.size).toBe(1);
      const winner = replacements[0]?.status === "fulfilled" ? 3 : 4;
      expect(await bytesOf(member!.id)).toEqual(new Uint8Array(await png(winner).arrayBuffer()));

      // An admin demoted while their upload is in flight is refused and does not replace the icon.
      storage.put = async (key, file, type) => {
        await put(key, file, type);
        checked.resolve();
        await demoted.promise;
      };
      const demotedUpload = images.store(workspace.id, admin!.id, png(6));
      await checked.promise;
      await db.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: admin!.id } },
        data: { role: "member" },
      });
      demoted.resolve();
      await expect(demotedUpload).rejects.toThrow("ACCESS_DENIED");
      expect(objects.size).toBe(1);
      expect(await bytesOf(member!.id)).toEqual(new Uint8Array(await png(winner).arrayBuffer()));
    } finally {
      uploaded.resolve();
      checked.resolve();
      demoted.resolve();
      storage.put = put;
    }

    storage.remove = async () => {
      throw new Error("Storage unavailable");
    };
    const replacement = await images.store(workspace.id, owner!.id, png(5));
    expect(replacement.iconUrl).toStartWith(`/api/workspaces/${workspace.id}/icon?v=`);
    expect(await bytesOf(member!.id)).toEqual(new Uint8Array(await png(5).arrayBuffer()));
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [owner!.id, admin!.id, member!.id, outsider!.id] } },
    });
    await db.$disconnect();
  }
});
