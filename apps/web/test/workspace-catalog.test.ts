import { expect, test } from "bun:test";

import {
  WorkspaceCatalog,
  type WorkspaceCatalogStore,
  type WorkspaceRecord,
} from "../src/server/workspaces/catalog.server";

const ada = "11111111-1111-4111-8111-111111111111";
const grace = "22222222-2222-4222-8222-222222222222";

test("lists the User's Workspaces in creation order", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await catalog.createForUser(ada, { name: "Research", slug: "research" });
  await catalog.createForUser(grace, { name: "Grace's Workspace", slug: "grace" });
  expect(await catalog.listForUser(ada)).toEqual([
    { id: "workspace-ada", slug: "ada", name: "Ada's Workspace" },
    { id: "workspace-research", slug: "research", name: "Research" },
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
  });
  expect(await catalog.selectForUser(ada)).toEqual({
    id: "workspace-ada",
    slug: "ada",
    name: "Ada's Workspace",
  });
});

test("rejects a taken or reserved Workspace slug", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await expect(catalog.createForUser(grace, { name: "Other", slug: "ada" })).rejects.toThrow(
    "workspace slug is taken",
  );
  await expect(catalog.createForUser(ada, { name: "Auth", slug: "auth" })).rejects.toThrow(
    "workspace slug is reserved",
  );
});

test("rejects an invalid Workspace slug or empty name", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await expect(catalog.createForUser(ada, { name: "Ada", slug: "Ada" })).rejects.toThrow(
    "workspace slug is invalid",
  );
  await expect(catalog.createForUser(ada, { name: "   ", slug: "team" })).rejects.toThrow(
    "workspace name is required",
  );
});

function memoryStore(): WorkspaceCatalogStore {
  const workspaces: WorkspaceRecord[] = [];
  const members = new Map<string, string[]>();
  return {
    async listForUser(userId) {
      const slugs = members.get(userId) ?? [];
      return slugs
        .map((slug) => workspaces.find((workspace) => workspace.slug === slug))
        .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));
    },
    async createWorkspace(input) {
      if (workspaces.some((workspace) => workspace.slug === input.slug)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const workspace = {
        id: `workspace-${input.slug}`,
        slug: input.slug,
        name: input.name,
      };
      workspaces.push(workspace);
      return workspace;
    },
    async addMember(workspaceId, userId) {
      const workspace = workspaces.find((row) => row.id === workspaceId);
      if (!workspace) throw new Error("missing workspace");
      const slugs = members.get(userId) ?? [];
      slugs.push(workspace.slug);
      members.set(userId, slugs);
    },
  };
}
