import { expect, test } from "bun:test";

import {
  WorkspaceEnrollment,
  type WorkspaceEnrollmentStore,
} from "../src/server/workspaces/enrollment.server";

const ada = { id: "11111111-1111-4111-8111-111111111111", username: "ada", displayName: "Ada" };
const grace = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "grace",
  displayName: "Grace",
};
const dong = {
  id: "33333333-3333-4333-8333-333333333333",
  username: "andong",
  displayName: "安栋",
};

test("a user with no membership gets a Workspace of their own", async () => {
  const store = memoryStore();
  const first = await new WorkspaceEnrollment(store).ensureForUser(ada, "en-US");
  expect(first.workspaceId).toBe("workspace-ada");
  expect(store.created).toEqual([{ slug: "ada", name: "Ada's Workspace" }]);
});

test("a second user gets a different Workspace", async () => {
  const enrollment = new WorkspaceEnrollment(memoryStore());
  const first = await enrollment.ensureForUser(ada, "en");
  const second = await enrollment.ensureForUser(grace, "en");
  expect(second.workspaceId).toBe("workspace-grace");
  expect(second.workspaceId).not.toBe(first.workspaceId);
});

test("Chinese Accept-Language names the Workspace in Chinese", async () => {
  const store = memoryStore();
  await new WorkspaceEnrollment(store).ensureForUser(dong, "zh-CN,zh;q=0.9,en;q=0.8");
  expect(store.created).toEqual([{ slug: "andong", name: "安栋的工作空间" }]);
});

test("the highest-quality language tag wins", async () => {
  const store = memoryStore();
  await new WorkspaceEnrollment(store).ensureForUser(dong, "en;q=0.8,zh-CN;q=1");
  expect(store.created[0]?.name).toBe("安栋的工作空间");
});

test("an existing membership is left unchanged", async () => {
  const store = memoryStore();
  await store.createWorkspace({ slug: "team", name: "Team" });
  await store.addMember("workspace-team", ada.id);
  const enrollment = new WorkspaceEnrollment(store);
  const result = await enrollment.ensureForUser(ada, "zh-CN");
  expect(result.workspaceId).toBe("workspace-team");
  expect(store.created).toEqual([{ slug: "team", name: "Team" }]);
});

test("a taken username slug still creates a Workspace for that User", async () => {
  const store = memoryStore();
  await store.createWorkspace({ slug: "ada", name: "Taken" });
  const enrollment = new WorkspaceEnrollment(store);
  const result = await enrollment.ensureForUser(ada, "en");
  expect(result.workspaceId).toBe("workspace-ada-11111111");
  expect(store.created.at(-1)).toEqual({ slug: "ada-11111111", name: "Ada's Workspace" });
});

function memoryStore(): WorkspaceEnrollmentStore & {
  created: { slug: string; name: string }[];
  createWorkspace(input: { slug: string; name: string }): Promise<string>;
  addMember(workspaceId: string, userId: string): Promise<void>;
} {
  const created: { slug: string; name: string }[] = [];
  const members = new Map<string, string>();
  return {
    created,
    async findMembership(userId) {
      return members.get(userId) ?? null;
    },
    async createWorkspace(input) {
      if (created.some((workspace) => workspace.slug === input.slug)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      created.push({ slug: input.slug, name: input.name });
      return `workspace-${input.slug}`;
    },
    async addMember(workspaceId, userId) {
      members.set(userId, workspaceId);
    },
  };
}
