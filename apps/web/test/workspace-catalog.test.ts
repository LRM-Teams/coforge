import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";

import {
  WorkspaceCatalog,
  type WorkspaceCatalogStore,
  type WorkspaceRecord,
} from "#src/server/workspaces/catalog.server";

const ada = "11111111-1111-4111-8111-111111111111";
const grace = "22222222-2222-4222-8222-222222222222";

test("lists the User's Workspaces in creation order", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await catalog.createForUser(ada, { name: "Research", slug: "research" });
  await catalog.createForUser(grace, {
    name: "Grace's Workspace",
    slug: "grace",
  });
  expect(await catalog.listForUser(ada)).toEqual([
    { id: "workspace-ada", slug: "ada", name: "Ada's Workspace", iconUrl: null },
    { id: "workspace-research", slug: "research", name: "Research", iconUrl: null },
  ]);
});

test("selects the preferred Workspace when the User is a member", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await catalog.createForUser(ada, { name: "Research", slug: "research" });
  expect(await catalog.selectForUser(ada, "research")).toEqual({
    id: "workspace-research",
    slug: "research",
    name: "Research",
    iconUrl: null,
  });
});

test("falls back to the earliest Workspace when the preference is missing", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await catalog.createForUser(ada, { name: "Research", slug: "research" });
  expect(await catalog.selectForUser(ada, "unknown")).toEqual({
    id: "workspace-ada",
    slug: "ada",
    name: "Ada's Workspace",
    iconUrl: null,
  });
  expect(await catalog.selectForUser(ada)).toEqual({
    id: "workspace-ada",
    slug: "ada",
    name: "Ada's Workspace",
    iconUrl: null,
  });
});

test("rejects a taken or reserved Workspace slug", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await expect(catalog.createForUser(grace, { name: "Other", slug: "ada" })).rejects.toEqual(
    new AppError("CONFLICT"),
  );
  await expect(catalog.createForUser(ada, { name: "Auth", slug: "auth" })).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
});

test("rejects an invalid Workspace slug or empty name", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await expect(catalog.createForUser(ada, { name: "Ada", slug: "Ada" })).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
  await expect(catalog.createForUser(ada, { name: "   ", slug: "team" })).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
});

test("does not expose unexpected persistence errors", async () => {
  const store = memoryStore();
  store.createForUser = async () => {
    throw new Error("internal database path");
  };

  await expect(
    new WorkspaceCatalog(store).createForUser(ada, {
      name: "Research",
      slug: "research",
    }),
  ).rejects.toThrow("workspace creation failed");
});

test("an owner or admin renames the Workspace to the trimmed name", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });

  expect(await catalog.rename(workspace.id, "owner", "  Research Lab  ")).toEqual({
    id: "workspace-ada",
    slug: "ada",
    name: "Research Lab",
    iconUrl: null,
  });
  await catalog.rename(workspace.id, "admin", "Grace's Lab");
  expect(await catalog.listForUser(ada)).toEqual([
    { id: "workspace-ada", slug: "ada", name: "Grace's Lab", iconUrl: null },
  ]);
});

test("a plain member, or an unrecognized role, cannot rename the Workspace", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });

  for (const role of ["member", "guest"])
    await expect(catalog.rename(workspace.id, role, "Taken over")).rejects.toEqual(
      new AppError("ACCESS_DENIED"),
    );
  expect((await catalog.listForUser(ada))[0]?.name).toBe("Ada's Workspace");
});

test("a Workspace name is 1 to 100 characters after trimming", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });

  await expect(catalog.rename(workspace.id, "owner", "   ")).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
  await expect(catalog.rename(workspace.id, "owner", "x".repeat(101))).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
  expect((await catalog.rename(workspace.id, "owner", ` ${"x".repeat(100)} `)).name).toBe(
    "x".repeat(100),
  );
});

function memoryStore(): WorkspaceCatalogStore {
  const workspaces: WorkspaceRecord[] = [];
  const members = new Map<string, string[]>();
  return {
    async rename(workspaceId, name) {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)!;
      workspace.name = name;
      return { ...workspace };
    },
    async listForUser(userId) {
      const slugs = members.get(userId) ?? [];
      return slugs
        .map((slug) => workspaces.find((workspace) => workspace.slug === slug))
        .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));
    },
    async createForUser(input) {
      if (workspaces.some((workspace) => workspace.slug === input.slug)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const workspace = {
        id: `workspace-${input.slug}`,
        slug: input.slug,
        name: input.name,
        iconUrl: null,
      };
      workspaces.push(workspace);
      const slugs = members.get(input.userId) ?? [];
      slugs.push(workspace.slug);
      members.set(input.userId, slugs);
      return { ...workspace };
    },
  };
}
