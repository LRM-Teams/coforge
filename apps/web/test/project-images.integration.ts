import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { FileStorage } from "@/server/files/file-storage.server";
import { ProjectImages } from "@/server/projects/project-images.server";
import { ProjectSettings } from "@/server/projects/project-settings.server";

test("project images authorize members, validate uploads, replace bytes and clean up on deletion", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `images-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `images-${suffix}`,
      name: "Images",
      members: { create: { userId: user.id } },
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
  const images = new ProjectImages(db, async () => storage);
  const settings = new ProjectSettings(db, undefined, async () => storage);
  const png = (byte: number) =>
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, byte])], "icon.png", {
      type: "image/png",
    });
  try {
    const project = await db.project.create({
      data: { workspaceId: workspace.id, slug: "images", name: "Images" },
    });
    await expect(
      images.store(workspace.id, crypto.randomUUID(), project.id, png(1)),
    ).rejects.toThrow("NOT_FOUND");
    await expect(images.store(crypto.randomUUID(), user.id, project.id, png(1))).rejects.toThrow(
      "NOT_FOUND",
    );
    for (const file of [
      new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }),
      new File(["not a png"], "icon.png", { type: "image/png" }),
      new File([], "empty.png", { type: "image/png" }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    ])
      await expect(images.store(workspace.id, user.id, project.id, file)).rejects.toThrow(
        "INVALID_INPUT",
      );
    expect(objects.size).toBe(0);

    const first = await images.store(workspace.id, user.id, project.id, png(1));
    expect(first.iconUrl).toStartWith(`/api/projects/${project.id}/icon?v=`);
    await expect(images.read(crypto.randomUUID(), project.id)).rejects.toThrow("NOT_FOUND");
    const read = await images.read(user.id, project.id);
    expect(read.contentType).toBe("image/png");
    expect(await new Response(read.body).bytes()).toEqual(
      new Uint8Array(await png(1).arrayBuffer()),
    );
    const previousKey = [...objects.keys()][0];
    const second = await images.store(workspace.id, user.id, project.id, png(2));
    expect(second.iconUrl).not.toBe(first.iconUrl);
    expect(objects.size).toBe(1);
    expect(objects.has(previousKey!)).toBeFalse();

    await settings.update(workspace.id, user.id, {
      id: project.id,
      name: "Renamed",
      description: "Metadata only",
      commitCoAuthor: true,
    });
    expect(await new Response((await images.read(user.id, project.id)).body).bytes()).toEqual(
      new Uint8Array(await png(2).arrayBuffer()),
    );

    const put = storage.put;
    const uploaded = Promise.withResolvers<void>();
    let arrivals = 0;
    storage.put = async (key, file, type) => {
      await put(key, file, type);
      if (++arrivals === 2) uploaded.resolve();
      await uploaded.promise;
    };
    const replacements = await Promise.allSettled([
      images.store(workspace.id, user.id, project.id, png(3)),
      images.store(workspace.id, user.id, project.id, png(4)),
    ]);
    storage.put = put;
    expect(replacements.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(replacements.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(objects.size).toBe(1);
    const winner = replacements[0]?.status === "fulfilled" ? 3 : 4;
    expect(await new Response((await images.read(user.id, project.id)).body).bytes()).toEqual(
      new Uint8Array(await png(winner).arrayBuffer()),
    );

    await expect(settings.delete(workspace.id, user.id, project.id, "Images")).rejects.toThrow(
      "INVALID_INPUT",
    );
    expect(objects.size).toBe(1);
    await settings.delete(workspace.id, user.id, project.id, "Renamed");
    expect(objects.size).toBe(0);
    await expect(images.read(user.id, project.id)).rejects.toThrow("NOT_FOUND");

    const cleanupProject = await db.project.create({
      data: { workspaceId: workspace.id, slug: "cleanup", name: "Cleanup" },
    });
    await images.store(workspace.id, user.id, cleanupProject.id, png(5));
    storage.remove = async () => {
      throw new Error("Storage unavailable");
    };
    const replacement = await images.store(workspace.id, user.id, cleanupProject.id, png(6));
    expect(replacement.iconUrl).toStartWith(`/api/projects/${cleanupProject.id}/icon?v=`);
    expect(
      await new Response((await images.read(user.id, cleanupProject.id)).body).bytes(),
    ).toEqual(new Uint8Array(await png(6).arrayBuffer()));
    await settings.delete(workspace.id, user.id, cleanupProject.id, "Cleanup");
    expect(await db.project.findUnique({ where: { id: cleanupProject.id } })).toBeNull();
    await expect(images.read(user.id, cleanupProject.id)).rejects.toThrow("NOT_FOUND");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
