import { expect, test } from "bun:test";

import {
  WorkspaceEnrollment,
  type WorkspaceEnrollmentStore,
} from "../src/server/workspaces/enrollment.server";

const ada = { id: "11111111-1111-4111-8111-111111111111", username: "ada" };
const grace = { id: "22222222-2222-4222-8222-222222222222", username: "grace" };

test("a user with no membership gets a Workspace of their own", async () => {
  const enrollment = new WorkspaceEnrollment(memoryStore());
  const first = await enrollment.ensureForUser(ada);
  expect(first.workspaceId).toBe("workspace-ada");
});

test("a second user gets a different Workspace", async () => {
  const enrollment = new WorkspaceEnrollment(memoryStore());
  const first = await enrollment.ensureForUser(ada);
  const second = await enrollment.ensureForUser(grace);
  expect(second.workspaceId).toBe("workspace-grace");
  expect(second.workspaceId).not.toBe(first.workspaceId);
});

test("an existing membership is left unchanged", async () => {
  const store = memoryStore();
  await store.createWorkspace({ slug: "team", name: "Team" });
  await store.addMember("workspace-team", ada.id);
  const enrollment = new WorkspaceEnrollment(store);
  const result = await enrollment.ensureForUser(ada);
  expect(result.workspaceId).toBe("workspace-team");
});

test("a taken username slug still creates a Workspace for that User", async () => {
  const store = memoryStore();
  await store.createWorkspace({ slug: "ada", name: "Taken" });
  const enrollment = new WorkspaceEnrollment(store);
  const result = await enrollment.ensureForUser(ada);
  expect(result.workspaceId).toBe("workspace-ada-11111111");
});

function memoryStore(): WorkspaceEnrollmentStore & {
  createWorkspace(input: { slug: string; name: string }): Promise<string>;
  addMember(workspaceId: string, userId: string): Promise<void>;
} {
  const workspaces: { id: string; slug: string }[] = [];
  const members = new Map<string, string>();
  return {
    async findMembership(userId) {
      return members.get(userId) ?? null;
    },
    async createWorkspace(input) {
      if (workspaces.some((workspace) => workspace.slug === input.slug)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const id = `workspace-${input.slug}`;
      workspaces.push({ id, slug: input.slug });
      return id;
    },
    async addMember(workspaceId, userId) {
      members.set(userId, workspaceId);
    },
  };
}
