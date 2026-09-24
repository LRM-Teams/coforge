import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { AgentAvatars } from "#src/server/agents/agent-avatar.server";
import type { FileStorage } from "#src/server/files/file-storage.server";

const png = (byte: number) =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, byte])], "avatar.png", {
    type: "image/png",
  });

function memoryStorage() {
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
  return { objects, storage };
}

type AgentRow = {
  id: string;
  workspaceId: string;
  ownerId: string;
  visibility: string;
  deletedAt: Date | null;
  avatarObjectKey: string | null;
  avatarContentType: string | null;
};

function fakeDb(seed: AgentRow) {
  const row = { ...seed };
  const members = new Map<string, string>([
    [seed.ownerId, "owner"],
    ["member-2", "member"],
  ]);
  const db = {
    agent: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== row.id || where.workspaceId !== row.workspaceId) return null;
        if (where.deletedAt === null && row.deletedAt) return null;
        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; avatarObjectKey: string | null };
        data: { avatarObjectKey: string | null; avatarContentType: string | null };
      }) => {
        if (where.id !== row.id || where.avatarObjectKey !== row.avatarObjectKey)
          return { count: 0 };
        row.avatarObjectKey = data.avatarObjectKey;
        row.avatarContentType = data.avatarContentType;
        return { count: 1 };
      },
    },
    workspaceMembership: {
      findUnique: async ({ where }: { where: { workspaceId_userId: { userId: string } } }) => {
        const role = members.get(where.workspaceId_userId.userId);
        return role ? { role } : null;
      },
    },
  };
  return { db, row };
}

test("only the creator replaces an Agent avatar, and a member of the Workspace can read it", async () => {
  const { objects, storage } = memoryStorage();
  const { db, row } = fakeDb({
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "owner-1",
    visibility: "public",
    deletedAt: null,
    avatarObjectKey: null,
    avatarContentType: null,
  });
  const avatars = new AgentAvatars(db as never, async () => storage);

  await expect(avatars.store("workspace-1", "member-2", "agent-1", png(1))).rejects.toEqual(
    new AppError("ACCESS_DENIED"),
  );
  expect(objects.size).toBe(0);

  const stored = await avatars.store("workspace-1", "owner-1", "agent-1", png(1));
  expect(stored.avatarUrl).toStartWith("/api/workspaces/workspace-1/agents/agent-1/avatar?v=");
  expect(row.avatarObjectKey).toContain("workspaces/workspace-1/agents/agent-1/avatars/");

  await expect(avatars.read("outsider", "workspace-1", "agent-1")).rejects.toEqual(
    new AppError("NOT_FOUND"),
  );
  const read = await avatars.read("member-2", "workspace-1", "agent-1");
  expect(read.contentType).toBe("image/png");
  expect(await new Response(read.body).bytes()).toEqual(new Uint8Array(await png(1).arrayBuffer()));

  const previous = row.avatarObjectKey;
  const replaced = await avatars.store("workspace-1", "owner-1", "agent-1", png(2));
  expect(replaced.avatarUrl).not.toBe(stored.avatarUrl);
  expect(objects.has(previous!)).toBeFalse();
  expect(objects.size).toBe(1);

  await avatars.remove("workspace-1", "owner-1", "agent-1");
  expect(row.avatarObjectKey).toBeNull();
  expect(objects.size).toBe(0);
  await expect(avatars.read("member-2", "workspace-1", "agent-1")).rejects.toEqual(
    new AppError("NOT_FOUND"),
  );
});

test("a deleted Agent cannot receive a new avatar", async () => {
  const { objects, storage } = memoryStorage();
  const { db } = fakeDb({
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "owner-1",
    visibility: "public",
    deletedAt: new Date("2026-09-01T00:00:00Z"),
    avatarObjectKey: null,
    avatarContentType: null,
  });
  const avatars = new AgentAvatars(db as never, async () => storage);

  await expect(avatars.store("workspace-1", "owner-1", "agent-1", png(1))).rejects.toEqual(
    new AppError("NOT_FOUND"),
  );
  expect(objects.size).toBe(0);
});

test("a member who cannot see a private Agent does not receive its picture", async () => {
  const { objects, storage } = memoryStorage();
  const { db } = fakeDb({
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "owner-1",
    visibility: "private",
    deletedAt: null,
    avatarObjectKey: "workspaces/workspace-1/agents/agent-1/avatars/pic/original",
    avatarContentType: "image/png",
  });
  objects.set("workspaces/workspace-1/agents/agent-1/avatars/pic/original", png(1));
  const avatars = new AgentAvatars(db as never, async () => storage);

  await expect(avatars.read("member-2", "workspace-1", "agent-1")).rejects.toMatchObject({
    code: "AGENT_NOT_VISIBLE",
  });
  const creator = await avatars.read("owner-1", "workspace-1", "agent-1");
  expect(creator.contentType).toBe("image/png");
});

test("an invalid image never reaches storage", async () => {
  const { objects, storage } = memoryStorage();
  const { db } = fakeDb({
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "owner-1",
    visibility: "public",
    deletedAt: null,
    avatarObjectKey: null,
    avatarContentType: null,
  });
  const avatars = new AgentAvatars(db as never, async () => storage);

  await expect(
    avatars.store(
      "workspace-1",
      "owner-1",
      "agent-1",
      new File(["not a png"], "avatar.png", { type: "image/png" }),
    ),
  ).rejects.toEqual(new AppError("INVALID_INPUT"));
  expect(objects.size).toBe(0);
});
