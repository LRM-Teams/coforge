import { expect, test } from "bun:test";

import {
  WorkspaceEnrollment,
  type WorkspaceEnrollmentStore,
} from "../src/server/workspaces/enrollment.server";

test("a user with no membership gets a default Workspace", async () => {
  const enrollment = new WorkspaceEnrollment(memoryStore());
  const first = await enrollment.ensureForUser("11111111-1111-4111-8111-111111111111");
  expect(first.workspaceId).toBe("workspace-default");
});

test("a second user joins the existing Workspace instead of creating another", async () => {
  const enrollment = new WorkspaceEnrollment(memoryStore());
  const first = await enrollment.ensureForUser("11111111-1111-4111-8111-111111111111");
  const second = await enrollment.ensureForUser("22222222-2222-4222-8222-222222222222");
  expect(second.workspaceId).toBe(first.workspaceId);
});

test("an existing membership is left unchanged", async () => {
  const store = memoryStore();
  await store.createWorkspace({ slug: "team", name: "Team" });
  await store.addMember("workspace-team", "11111111-1111-4111-8111-111111111111");
  const enrollment = new WorkspaceEnrollment(store);
  const result = await enrollment.ensureForUser("11111111-1111-4111-8111-111111111111");
  expect(result.workspaceId).toBe("workspace-team");
});

function memoryStore(): WorkspaceEnrollmentStore & {
  createWorkspace(input: { slug: string; name: string }): Promise<string>;
  addMember(workspaceId: string, userId: string): Promise<void>;
} {
  const workspaces: { id: string; slug: string; createdAt: number }[] = [];
  const members = new Map<string, string>();
  return {
    async findMembership(userId) {
      return members.get(userId) ?? null;
    },
    async findFirstWorkspace() {
      return workspaces[0]?.id ?? null;
    },
    async createWorkspace(input) {
      const id = `workspace-${input.slug}`;
      workspaces.push({ id, slug: input.slug, createdAt: workspaces.length });
      return id;
    },
    async addMember(workspaceId, userId) {
      members.set(userId, workspaceId);
    },
  };
}
