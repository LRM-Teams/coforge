import { expect, test } from "bun:test";

import { USERNAME_PATTERN } from "#src/lib/username-grammar";
import {
  planUsernameRenames,
  type RenameCandidate,
} from "#src/server/auth/username-rename-plan.server";

/**
 * The one-time rename of existing usernames to the readable form the allocator now produces: a
 * pure plan over the users and the Agent names each of them must not share, so every rule is
 * checked here without a database. The database seam is `username-rename.integration.test.ts`.
 */

const idOf = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function person(n: number, fields: Partial<RenameCandidate> & { username: string }) {
  return {
    id: idOf(n),
    email: null,
    fullName: null,
    displayName: null,
    createdAt: new Date(Date.UTC(2026, 0, n)),
    agentNames: [],
    ...fields,
  } satisfies RenameCandidate;
}

/** The usernames after the plan is applied, by user id. */
function afterPlan(users: RenameCandidate[]) {
  const renamed = new Map(planUsernameRenames(users).map((rename) => [rename.userId, rename.to]));
  return users.map((user) => ({ ...user, username: renamed.get(user.id) ?? user.username }));
}

test("an id-suffixed name from before readable names becomes the email's local part", () => {
  const legacy = person(0xd9956ab1, { username: "andong3-d9956ab1", email: "andong3@example.com" });

  expect(planUsernameRenames([legacy])).toEqual([
    { userId: legacy.id, from: "andong3-d9956ab1", to: "andong3", source: "email" },
  ]);
});

test("a name that is already what the rules produce is left alone", () => {
  const settled = person(1, { username: "andong3", email: "andong3@example.com" });

  expect(planUsernameRenames([settled])).toEqual([]);
});

test("a readable name the person has is kept even when their email would name them otherwise", () => {
  // Without `preferred_username` in the database, the name they have stands in for it: the
  // allocator tries it first, so a readable one is what it produced.
  const chosen = person(1, { username: "frankan", email: "me.frankan@example.com" });

  expect(planUsernameRenames([chosen])).toEqual([]);
});

test("a chosen name that starts with a digit gets the prefix u", () => {
  const digits = person(1, { username: "9lives", email: "cat@example.com" });

  expect(planUsernameRenames([digits])).toEqual([
    { userId: digits.id, from: "9lives", to: "u9lives", source: "current-name" },
  ]);
});

test("a name of eleven digits, which may be a phone number, is replaced by the next source", () => {
  const phone = person(1, { username: "13800138000", email: "ada@example.com" });

  expect(planUsernameRenames([phone])).toEqual([
    { userId: phone.id, from: "13800138000", to: "ada", source: "email" },
  ]);
});

test("a reserved word is replaced by the next source", () => {
  const reserved = person(1, { username: "admin", email: "grace@example.com" });

  expect(planUsernameRenames([reserved])).toEqual([
    { userId: reserved.id, from: "admin", to: "grace", source: "email" },
  ]);
});

test("without an email, the local part the old name was built from is used", () => {
  const legacy = person(0xd9956ab1, { username: "andong3-d9956ab1" });

  expect(planUsernameRenames([legacy])).toEqual([
    { userId: legacy.id, from: "andong3-d9956ab1", to: "andong3", source: "old-name" },
  ]);
});

test("with neither, the full name, then the display name, then user name the person", () => {
  const byFullName = person(0xaaaaaaaa, {
    username: `user-${idOf(0xaaaaaaaa).replaceAll("-", "")}`,
    fullName: "Grace Hopper",
    displayName: "Amazing",
  });
  const byDisplayName = person(0xbbbbbbbb, {
    username: `user-${idOf(0xbbbbbbbb).replaceAll("-", "")}`,
    fullName: "安栋",
    displayName: "Dong",
  });
  const byNothing = person(0xcccccccc, {
    username: `user-${idOf(0xcccccccc).replaceAll("-", "")}`,
    fullName: "安栋",
  });

  expect(planUsernameRenames([byFullName, byDisplayName, byNothing])).toEqual([
    { userId: byFullName.id, from: byFullName.username, to: "grace-hopper", source: "full-name" },
    { userId: byDisplayName.id, from: byDisplayName.username, to: "dong", source: "display-name" },
    { userId: byNothing.id, from: byNothing.username, to: "user", source: "fallback" },
  ]);
});

test("people who would share a name get the smallest free -N, the oldest account first", () => {
  const younger = person(0xbbbbbbbb, {
    username: "ada-bbbbbbbb",
    email: "ada@example.com",
    createdAt: new Date("2026-03-01"),
  });
  const older = person(0xaaaaaaaa, {
    username: "ada-aaaaaaaa",
    email: "ada@example.com",
    createdAt: new Date("2026-02-01"),
  });
  const youngest = person(0xcccccccc, {
    username: "ada-cccccccc",
    email: "ada@example.com",
    createdAt: new Date("2026-04-01"),
  });

  const plan = planUsernameRenames([younger, youngest, older]);

  expect(plan.map((rename) => [rename.userId, rename.to])).toEqual([
    [older.id, "ada"],
    [younger.id, "ada-2"],
    [youngest.id, "ada-3"],
  ]);
});

test("a person who keeps their name keeps it whichever account is older", () => {
  const legacy = person(0xaaaaaaaa, {
    username: "ada-aaaaaaaa",
    email: "ada@example.com",
    createdAt: new Date("2026-01-01"),
  });
  const keeper = person(2, {
    username: "ada",
    email: "ada@example.com",
    createdAt: new Date("2026-06-01"),
  });

  expect(planUsernameRenames([legacy, keeper])).toEqual([
    { userId: legacy.id, from: "ada-aaaaaaaa", to: "ada-2", source: "email" },
  ]);
});

test("a name given up in the same plan is not handed to another person", () => {
  // `ada` is renamed (a live Agent has it), and is still not free for `ada-bbbbbbbb`: no update
  // may depend on the order the others run in.
  const reserved = person(1, { username: "ada", agentNames: ["ada"], email: "ada@example.com" });
  const legacy = person(0xbbbbbbbb, { username: "ada-bbbbbbbb", email: "ada@example.com" });

  const plan = planUsernameRenames([reserved, legacy]);

  expect(plan.map((rename) => rename.to)).toEqual(["ada-2", "ada-3"]);
});

test("a planned name is never one that any account has now", () => {
  const users = [
    person(0xaaaaaaaa, { username: "bob-aaaaaaaa", email: "bob@example.com" }),
    person(2, { username: "bob", email: "bob@example.com" }),
    person(3, { username: "bob-2", email: "bob@example.com" }),
    person(0xdddddddd, { username: "bob-dddddddd", email: "bob@example.com" }),
  ];
  const current = new Set(users.map((user) => user.username));

  for (const rename of planUsernameRenames(users)) expect(current.has(rename.to)).toBe(false);
});

test("the plan does not depend on the order the users are read in", () => {
  const users = [
    person(0xaaaaaaaa, { username: "ada-aaaaaaaa", email: "ada@example.com" }),
    person(0xbbbbbbbb, { username: "ada-bbbbbbbb", email: "ada@example.com" }),
    person(3, { username: "9lives", email: "cat@example.com" }),
    person(0xcccccccc, { username: "user-cccccccc", fullName: "Ada Byron" }),
  ];
  const byUser = (plan: ReturnType<typeof planUsernameRenames>) =>
    plan.map((rename) => [rename.userId, rename.to]).sort();

  expect(byUser(planUsernameRenames([...users].reverse()))).toEqual(
    byUser(planUsernameRenames(users)),
  );
});

test("a new name is never the name of a live Agent the person shares a Workspace with", () => {
  const legacy = person(0xaaaaaaaa, {
    username: "ada-aaaaaaaa",
    email: "ada@example.com",
    agentNames: ["ada", "ada-2", "bob"],
  });

  expect(planUsernameRenames([legacy])).toEqual([
    { userId: legacy.id, from: "ada-aaaaaaaa", to: "ada-3", source: "email" },
  ]);
});

test("a person whose own readable name is such an Agent's name is renamed too", () => {
  // The Agent's name cannot change, and `@ada` must name one of them.
  const clash = person(1, { username: "ada", email: "ada@example.com", agentNames: ["ada"] });

  expect(planUsernameRenames([clash])).toEqual([
    { userId: clash.id, from: "ada", to: "ada-2", source: "current-name" },
  ]);
});

test("an Agent that shares no Workspace with the person does not matter", () => {
  // `agentNames` holds only the Agents of the person's Workspaces, so another person's list has
  // no bearing on this one's name.
  const first = person(0xaaaaaaaa, { username: "ada-aaaaaaaa", email: "ada@example.com" });
  const second = person(0xbbbbbbbb, {
    username: "ada-bbbbbbbb",
    email: "ada@example.com",
    agentNames: ["ada"],
  });

  expect(planUsernameRenames([first, second]).map((rename) => rename.to)).toEqual(["ada", "ada-2"]);
});

test("a second run over the renamed users plans nothing", () => {
  const users = [
    person(0xaaaaaaaa, { username: "ada-aaaaaaaa", email: "ada@example.com" }),
    person(0xbbbbbbbb, { username: "ada-bbbbbbbb", email: "ada@example.com" }),
    person(3, { username: "ada", email: "ada@example.com", agentNames: ["ada"] }),
    person(4, { username: "9lives", email: "cat@example.com" }),
    person(5, { username: "13800138000", fullName: "Ada Byron" }),
    person(0xcccccccc, { username: `user-${idOf(0xcccccccc).replaceAll("-", "")}` }),
    person(0xdddddddd, { username: "user-dddddddd", fullName: "安栋" }),
    person(8, { username: "frankan", email: "me.frankan@example.com" }),
    person(9, { username: "admin", email: "admin@example.com" }),
  ];

  const renamed = afterPlan(users);

  const plan = planUsernameRenames(users);
  expect(plan).not.toEqual([]);
  // Every new name is one the grammar allows.
  for (const rename of plan) expect(USERNAME_PATTERN.test(rename.to)).toBe(true);
  expect(planUsernameRenames(renamed)).toEqual([]);
  expect(new Set(renamed.map((user) => user.username)).size).toBe(users.length);
});
