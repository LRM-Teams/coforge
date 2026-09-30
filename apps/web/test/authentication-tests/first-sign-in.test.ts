import { expect, test } from "bun:test";

import { FirstSignIn, type FirstSignInNames } from "#src/server/auth/first-sign-in.server";
import {
  WorkspaceEnrollment,
  type WorkspaceEnrollmentStore,
} from "#src/server/workspaces/enrollment.server";

// The first sign-in's name step, at its use-case seam: a person's full name is saved, then their
// personal Workspace is made, titled with it. Both stores are in memory, so the tests read the
// outcome through the same interface the callback and the page use.

const ada = { id: "11111111-1111-4111-8111-111111111111", username: "ada" };

function setup(
  input: {
    named?: Record<string, string>;
    memberships?: Record<string, string>;
    /** Whether the person's row exists; a session can outlive it. */
    userExists?: boolean;
  } = {},
) {
  const users = new Set(input.userExists === false ? [] : [ada.id]);
  const names = new Map(Object.entries(input.named ?? {}));
  const memberships = new Map(Object.entries(input.memberships ?? {}));
  const created: { slug: string; name: string; userId: string }[] = [];
  const enrollmentStore: WorkspaceEnrollmentStore = {
    async findMembership(userId) {
      return memberships.get(userId) ?? null;
    },
    async createForUser(workspace) {
      created.push(workspace);
      const workspaceId = `workspace-${workspace.slug}`;
      memberships.set(workspace.userId, workspaceId);
      return workspaceId;
    },
  };
  const nameStore: FirstSignInNames = {
    async lookup(userId) {
      return users.has(userId) ? { fullName: names.get(userId) ?? null } : null;
    },
    async setFullNameOnce(userId, fullName) {
      if (!names.has(userId)) names.set(userId, fullName);
      return names.get(userId)!;
    },
  };
  return {
    firstSignIn: new FirstSignIn(nameStore, new WorkspaceEnrollment(enrollmentStore)),
    names,
    created,
  };
}

test("a full name is saved, and the personal Workspace is titled with it", async () => {
  const { firstSignIn, names, created } = setup();

  const result = await firstSignIn.complete({
    user: ada,
    fullName: "  Ada   Lovelace ",
    acceptLanguage: "en-US",
  });

  expect(result).toEqual({ ok: true, workspaceId: "workspace-ada" });
  expect(names.get(ada.id)).toBe("Ada Lovelace");
  expect(created).toEqual([{ slug: "ada", name: "Ada Lovelace's Workspace", userId: ada.id }]);
});

test("the Workspace title follows the language the person reads", async () => {
  const { firstSignIn, created } = setup();

  await firstSignIn.complete({ user: ada, fullName: "安栋", acceptLanguage: "zh-CN,zh;q=0.9" });

  expect(created.map((workspace) => workspace.name)).toEqual(["安栋的工作空间"]);
});

test("a name that is not accepted saves nothing and makes no Workspace", async () => {
  const { firstSignIn, names, created } = setup();

  expect(await firstSignIn.complete({ user: ada, fullName: "   ", acceptLanguage: "en" })).toEqual({
    ok: false,
    problem: "empty",
  });
  expect(
    await firstSignIn.complete({ user: ada, fullName: "a".repeat(81), acceptLanguage: "en" }),
  ).toEqual({ ok: false, problem: "too_long" });
  expect(
    await firstSignIn.complete({ user: ada, fullName: "System", acceptLanguage: "en" }),
  ).toEqual({ ok: false, problem: "refused" });
  expect(names.size).toBe(0);
  expect(created).toEqual([]);
});

test("someone already in a Workspace keeps it: the name is saved and their memberships come back as they are", async () => {
  const { firstSignIn, names, created } = setup({ memberships: { [ada.id]: "workspace-team" } });

  const result = await firstSignIn.complete({
    user: ada,
    fullName: "Ada Lovelace",
    acceptLanguage: "en",
  });

  expect(result).toEqual({ ok: true, workspaceId: "workspace-team" });
  expect(names.get(ada.id)).toBe("Ada Lovelace");
  expect(created).toEqual([]);
});

test("the name step is idempotent: a second submit, even with another name, changes nothing", async () => {
  const { firstSignIn, names, created } = setup();

  const first = await firstSignIn.complete({
    user: ada,
    fullName: "Ada Lovelace",
    acceptLanguage: "en",
  });
  const second = await firstSignIn.complete({
    user: ada,
    fullName: "Ada King",
    acceptLanguage: "en",
  });

  expect(second).toEqual(first);
  expect(names.get(ada.id)).toBe("Ada Lovelace");
  expect(created).toHaveLength(1);
});

test("a named person who has no Workspace gets one titled with the name already stored", async () => {
  const { firstSignIn, created } = setup({ named: { [ada.id]: "Ada Lovelace" } });

  await firstSignIn.complete({ user: ada, fullName: "Someone Else", acceptLanguage: "en" });

  expect(created.map((workspace) => workspace.name)).toEqual(["Ada Lovelace's Workspace"]);
});

// What the /welcome page needs to know: whether to ask at all, and what to start the field with.

test("a person who has a full name is not asked", async () => {
  const { firstSignIn } = setup({ named: { [ada.id]: "Ada Lovelace" } });

  expect(await firstSignIn.readNameStep({ id: ada.id, name: "Ada" })).toEqual({ status: "named" });
});

test("a person without one is asked, starting from the provider's name when it reads as a name", async () => {
  const { firstSignIn } = setup();

  expect(await firstSignIn.readNameStep({ id: ada.id, name: " Ada  Lovelace " })).toEqual({
    status: "ask",
    prefill: "Ada Lovelace",
  });
  expect(await firstSignIn.readNameStep({ id: ada.id, name: "13800138000" })).toEqual({
    status: "ask",
    prefill: "",
  });
  expect(await firstSignIn.readNameStep({ id: ada.id, name: "" })).toEqual({
    status: "ask",
    prefill: "",
  });
});

test("a session whose user is gone is not asked: it has to sign in again", async () => {
  const { firstSignIn } = setup({ userExists: false });

  expect(await firstSignIn.readNameStep({ id: ada.id, name: "Ada" })).toEqual({
    status: "account_gone",
  });
});

test("a name the rule refuses is told apart from an empty or a too-long one", async () => {
  const { firstSignIn, names, created } = setup();
  const ask = (fullName: string) =>
    firstSignIn.complete({ user: ada, fullName, acceptLanguage: "en" });

  expect(await ask("@ada")).toEqual({ ok: false, problem: "refused" });
  expect(await ask("\u200b")).toEqual({ ok: false, problem: "refused" });
  expect(await ask("Ada\u202eLovelace")).toEqual({ ok: false, problem: "refused" });
  expect(await ask("")).toEqual({ ok: false, problem: "empty" });
  expect(names.size).toBe(0);
  expect(created).toEqual([]);
});
