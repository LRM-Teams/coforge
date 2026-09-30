import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  applyUsernameRenames,
  readRenameCandidates,
} from "#src/server/auth/username-rename-copies.repository.server";
import type { UsernameRenameDump } from "#src/server/auth/username-rename-dump.server";
import {
  previewUsernameRenames,
  renameUsernames,
  restoreUsernames,
} from "#src/server/auth/username-rename.server";
import { findUsernameViolations } from "#src/server/auth/username-rename-violations.server";
import { planUsernameRenames } from "#src/server/auth/username-rename-plan.server";

/**
 * The one-time username rename against PostgreSQL: what it reads, which copies of a username it
 * rewrites, what it refuses, and that the dump takes everything back. Each run works in a database
 * of its own on the same server, created from the migrations and dropped afterwards, because the
 * rename plans every user in the database it is given and would rewrite the rest of a shared one.
 *
 * Skipped unless `MIGRATION_TEST_DATABASE_URL` points at a PostgreSQL server the test may create
 * databases on.
 */
const serverUrl = Bun.env.MIGRATION_TEST_DATABASE_URL;
const webRoot = join(import.meta.dir, "..");

const scratchName = `username_rename_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let scratchUrl = "";
let db: PrismaClient;
/** Every SQL statement the client sent, in order, so a test can see what came before what. */
const statements: string[] = [];
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  if (!serverUrl) return;
  const target = new URL(serverUrl);
  target.pathname = `/${scratchName}`;
  scratchUrl = target.toString();
  const admin = new Pool({ connectionString: serverUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${scratchName}"`);
  } finally {
    await admin.end();
  }
  const migrate = Bun.spawn(["bunx", "--bun", "prisma", "migrate", "deploy"], {
    cwd: webRoot,
    env: { ...process.env, DATABASE_URL: scratchUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(migrate.stderr).text(),
    migrate.exited,
  ]);
  if (exitCode !== 0) throw new Error(`prisma migrate deploy failed: ${stderr}`);
  const logged = new PrismaClient({
    adapter: new PrismaPg({ connectionString: scratchUrl }),
    log: [{ emit: "event", level: "query" }],
  });
  logged.$on("query", (event) => statements.push(event.query));
  db = logged;
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  if (!serverUrl) return;
  const admin = new Pool({ connectionString: serverUrl, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  if (!serverUrl) return;
  await db.$executeRawUnsafe(`TRUNCATE "users", "workspaces", "computers" CASCADE`);
});

const RUNTIME = { runtime: "pi" };
/** A title change as the history records it: the title as an Agent reads it, mentions as text. */
const AMENDED_PAYLOAD = {
  revision: 1,
  changes: {
    title: {
      from: "ping @andong3-d9956ab1",
      to: "ping @andong3-d9956ab1 and @ada-bbbbbbbb, not @andong3-d9956ab1x",
    },
    description: { from: "see @andong3-d9956ab1", to: "see @ada-bbbbbbbb" },
  },
};
const ids = {
  andong: "d9956ab1-0000-4000-8000-00000000a001",
  nine: "00000002-0000-4000-8000-00000000a002",
  ada: "bbbbbbbb-0000-4000-8000-00000000a003",
  keeper: "00000004-0000-4000-8000-00000000a004",
  owner: "00000005-0000-4000-8000-00000000a005",
};

/**
 * Two Workspaces with people who need renaming and people who do not, an Agent that clashes with
 * one of the new names in each, an Agent in a third Workspace nobody here belongs to, and one copy
 * of each username in every table that keeps one.
 */
async function seedWorld() {
  const user = (key: keyof typeof ids, username: string, email: string | null) =>
    db.user.create({ data: { id: ids[key], username, email } });
  await Promise.all([
    user("andong", "andong3-d9956ab1", "andong3@example.com"),
    user("nine", "9lives", "cat@example.com"),
    user("ada", "ada-bbbbbbbb", "ada@example.com"),
    user("keeper", "frankan", "me.frankan@example.com"),
    user("owner", "wsowner", null),
  ]);
  const workspace = (slug: string, members: (keyof typeof ids)[]) =>
    db.workspace.create({
      data: {
        slug,
        name: slug,
        members: { create: members.map((key) => ({ userId: ids[key] })) },
      },
    });
  const [first, second, third] = [
    await workspace("first", ["andong", "nine", "ada", "keeper", "owner"]),
    await workspace("second", ["ada", "owner"]),
    await workspace("third", ["owner"]),
  ];
  const computer = await db.computer.create({
    data: { ownerId: ids.owner, machineId: crypto.randomUUID() },
  });
  await db.workspaceComputer.create({ data: { workspaceId: first!.id, computerId: computer.id } });
  const agent = (workspaceId: string, name: string) =>
    db.agent.create({
      data: {
        workspaceId,
        name,
        displayName: name,
        ownerId: ids.owner,
        computerId: computer.id,
        runtimeConfig: RUNTIME,
      },
    });
  const firstAgent = await agent(first!.id, "ada");
  await agent(second!.id, "ada-2");
  await agent(third!.id, "andong3");

  const channel = await db.conversation.create({
    data: { workspaceId: first!.id, channelName: "team" },
  });
  const member = async (userId: string | null, agentId?: string) =>
    db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: first!.id, userId, agentId },
    });
  const members = {
    owner: await member(ids.owner),
    andong: await member(ids.andong),
    ada: await member(ids.ada),
    keeper: await member(ids.keeper),
    agent: await member(null, firstAgent.id),
  };
  const send = (sequence: number, body: string) =>
    db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId: first!.id,
        senderMemberId: members.owner.id,
        sequence,
        body,
      },
    });
  const [mentioning, tasked, pending] = [
    await send(1, "hello"),
    await send(2, "a task"),
    await send(3, "hi @andong3-d9956ab1"),
  ];
  const mention = (
    target: keyof typeof members,
    kind: "user" | "agent",
    actorId: string,
    handle: string,
  ) =>
    db.messageMention.create({
      data: {
        messageId: mentioning!.id,
        memberId: members[target].id,
        conversationId: channel.id,
        workspaceId: first!.id,
        kind,
        actorId,
        handle,
      },
    });
  await mention("andong", "user", ids.andong, "andong3-d9956ab1");
  await mention("ada", "user", ids.ada, "ada-bbbbbbbb");
  await mention("keeper", "user", ids.keeper, "frankan");
  await mention("agent", "agent", firstAgent.id, "ada");

  await db.task.create({
    data: {
      messageId: tasked!.id,
      conversationId: channel.id,
      workspaceId: first!.id,
      number: 1,
      title: "a task",
      creatorMemberId: members.owner.id,
    },
  });
  const history = (seq: number, actorType: string, actorName: string) => ({
    taskMessageId: tasked!.id,
    seq,
    eventType: "status_changed",
    actorType,
    actorName,
    payload: {},
  });
  await db.taskHistoryEvent.createMany({
    data: [
      history(1, "user", "wsowner"),
      history(2, "user", "andong3-d9956ab1"),
      // An Agent's name is not a username: only a person's rows are the person's.
      history(3, "agent", "andong3-d9956ab1"),
      {
        ...history(4, "user", "wsowner"),
        eventType: "amended",
        payload: AMENDED_PAYLOAD,
      },
    ],
  });
  await db.pendingMentionAction.create({
    data: {
      messageId: pending!.id,
      conversationId: channel.id,
      workspaceId: first!.id,
      senderMemberId: members.owner.id,
      targetUserId: ids.andong,
      targetHandle: "andong3-d9956ab1",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const reminder = (target: string) =>
    db.reminder.create({
      data: {
        workspaceId: first!.id,
        ownerAgentId: firstAgent.id,
        computerId: computer.id,
        title: "ping",
        target,
        messageId: mentioning!.id,
        fireAt: new Date(Date.now() + 3_600_000),
      },
    });
  for (const target of [
    "@andong3-d9956ab1",
    "@andong3-d9956ab1:abcd1234",
    "@andong3-d9956ab1x",
    "@frankan",
    "#team",
  ])
    await reminder(target);
}

/** Every stored copy of a username, in an order the database's collation does not decide. */
async function snapshot() {
  const [users, mentions, history, pending, reminders] = await Promise.all([
    db.user.findMany({ select: { id: true, username: true } }),
    db.messageMention.findMany({ select: { kind: true, actorId: true, handle: true } }),
    db.taskHistoryEvent.findMany({
      select: { seq: true, actorType: true, actorName: true, payload: true },
    }),
    db.pendingMentionAction.findMany({ select: { targetHandle: true } }),
    db.reminder.findMany({ select: { target: true } }),
  ]);
  const ordered = <T>(rows: T[]) =>
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    users: ordered(users),
    mentions: ordered(mentions),
    history: ordered(history),
    pending: ordered(pending),
    reminders: ordered(reminders),
  };
}

/**
 * Titles that name an Agent by the same text as a person's username, where the person is not the
 * one meant: in a Workspace the person is not in (Agents named like a renamed person's old and new
 * name), and in one they are in where a live Agent has their old name.
 */
async function seedAgentTitles() {
  const workspace = (slug: string, members: (keyof typeof ids)[]) =>
    db.workspace.create({
      data: { slug, name: slug, members: { create: members.map((key) => ({ userId: ids[key] })) } },
    });
  const outside = await workspace("fourth", ["owner"]);
  const shared = await workspace("fifth", ["owner", "nine"]);
  const agent = (workspaceId: string, name: string) =>
    db.agent.create({
      data: { workspaceId, name, displayName: name, ownerId: ids.owner, runtimeConfig: RUNTIME },
    });
  await agent(outside.id, "andong3");
  await agent(outside.id, "andong3-d9956ab1");
  await agent(shared.id, "9lives");
  const titled = async (workspaceId: string, title: string) => {
    const channel = await db.conversation.create({
      data: { workspaceId, channelName: `titles-${crypto.randomUUID().slice(0, 8)}` },
    });
    const member = await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId, userId: ids.owner },
    });
    const message = await db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        senderMemberId: member.id,
        sequence: 1,
        body: title,
      },
    });
    await db.task.create({
      data: {
        messageId: message.id,
        conversationId: channel.id,
        workspaceId,
        number: 1,
        title,
        creatorMemberId: member.id,
      },
    });
    await db.taskHistoryEvent.create({
      data: {
        taskMessageId: message.id,
        seq: 1,
        eventType: "amended",
        actorType: "user",
        actorName: "wsowner",
        payload: { revision: 1, changes: { title: { from: "before", to: title } } },
      },
    });
    return message.id;
  };
  const titles = {
    newName: "ask @andong3 (an Agent)",
    oldName: "ask @andong3-d9956ab1 (an Agent)",
    sharedOldName: "ping @9lives (an Agent)",
  };
  await titled(outside.id, titles.newName);
  await titled(outside.id, titles.oldName);
  await titled(shared.id, titles.sharedOldName);
  return titles;
}

/** The `to` of every title change in the given titles' events, in a stable order. */
async function amendedTitles() {
  const rows = await db.taskHistoryEvent.findMany({
    where: { eventType: "amended" },
    select: { payload: true },
  });
  return rows
    .map((row) => (row.payload as { changes: { title: { to: string } } }).changes.title.to)
    .sort();
}

const skipped = !serverUrl;
if (skipped) console.warn("username rename test not run: set MIGRATION_TEST_DATABASE_URL");

async function planNow() {
  return planUsernameRenames(await readRenameCandidates(db));
}

test.skipIf(skipped)(
  "the plan reads the Agents of each person's own Workspaces, and only the live ones",
  async () => {
    await seedWorld();
    // A deleted Agent no longer has its name (it is given an id-suffixed one), but the flag alone
    // must take it out of the plan.
    await db.agent.updateMany({ where: { name: "ada-2" }, data: { deletedAt: new Date() } });

    const plan = await planNow();

    expect(plan.map((rename) => [rename.from, rename.to, rename.source].join(" ")).sort()).toEqual([
      "9lives u9lives current-name",
      "ada-bbbbbbbb ada-2 email",
      "andong3-d9956ab1 andong3 email",
    ]);
  },
);

test.skipIf(skipped)(
  "the plan avoids the Agent names of every Workspace the person belongs to",
  async () => {
    await seedWorld();

    const plan = await planNow();

    expect(plan.find((rename) => rename.userId === ids.ada)?.to).toBe("ada-3");
    // The Agent `andong3` is in a Workspace `andong` is not in.
    expect(plan.find((rename) => rename.userId === ids.andong)?.to).toBe("andong3");
  },
);

test.skipIf(skipped)(
  "applying renames the users and every copy of their username, and nothing else",
  async () => {
    await seedWorld();

    const dumps: UsernameRenameDump[] = [];
    const plan = await renameUsernames(db, async (dump) => {
      dumps.push(dump);
    });

    expect(plan).toHaveLength(3);
    expect(dumps).toHaveLength(1);
    const after = await snapshot();
    const usernames = Object.fromEntries(after.users.map((user) => [user.id, user.username]));
    expect(usernames).toEqual({
      [ids.andong]: "andong3",
      [ids.nine]: "u9lives",
      [ids.ada]: "ada-3",
      [ids.keeper]: "frankan",
      [ids.owner]: "wsowner",
    });
    const handles = after.mentions.map((row) => `${row.kind}:${row.handle}`).sort();
    expect(handles).toEqual(["agent:ada", "user:ada-3", "user:andong3", "user:frankan"]);
    expect(
      after.history.map((row) => `${row.seq}:${row.actorType}:${row.actorName}`).sort(),
    ).toEqual(["1:user:wsowner", "2:user:andong3", "3:agent:andong3-d9956ab1", "4:user:wsowner"]);
    // The title change names people as text: the renamed ones are written with their new names,
    // `@andong3-d9956ab1x` is someone else's, and the description is stored as written.
    expect(after.history.find((row) => row.seq === 4)?.payload).toEqual({
      revision: 1,
      changes: {
        title: {
          from: "ping @andong3",
          to: "ping @andong3 and @ada-3, not @andong3-d9956ab1x",
        },
        description: AMENDED_PAYLOAD.changes.description,
      },
    });
    expect(after.pending).toEqual([{ targetHandle: "andong3" }]);
    expect(after.reminders.map((row) => row.target).sort()).toEqual([
      "#team",
      "@andong3",
      "@andong3-d9956ab1x",
      "@andong3:abcd1234",
      "@frankan",
    ]);
    expect(await findUsernameViolations(db)).toEqual([]);
  },
);

test.skipIf(skipped)("the dump is handed over before the transaction writes anything", async () => {
  await seedWorld();
  const written = /^(INSERT|UPDATE|DELETE)\b/;
  statements.length = 0;

  await renameUsernames(db, async () => {
    // What the transaction itself has sent so far, not what a second connection can see.
    statements.push("--- dump written ---");
  });

  const at = statements.indexOf("--- dump written ---");
  expect(at).toBeGreaterThan(0);
  expect(statements.slice(0, at).filter((sql) => written.test(sql))).toEqual([]);
  expect(statements.slice(at).some((sql) => sql.startsWith('UPDATE "public"."users"'))).toBe(true);
});

test.skipIf(skipped)("the dump holds the old value of every row the rename changes", async () => {
  await seedWorld();
  const dumps: UsernameRenameDump[] = [];

  await renameUsernames(db, async (dump) => {
    dumps.push(dump);
  });

  const [dump] = dumps;
  expect(dump!.format).toBe("coforge-username-rename-dump/1");
  expect(dump!.renames.map((rename) => `${rename.from} ${rename.to}`).sort()).toEqual([
    "9lives u9lives",
    "ada-bbbbbbbb ada-3",
    "andong3-d9956ab1 andong3",
  ]);
  expect(dump!.rows.users.map((row) => row.username).sort()).toEqual([
    "9lives",
    "ada-bbbbbbbb",
    "andong3-d9956ab1",
  ]);
  expect(dump!.rows.messageMentions.map((row) => row.handle).sort()).toEqual([
    "ada-bbbbbbbb",
    "andong3-d9956ab1",
  ]);
  expect(dump!.rows.taskHistoryEvents.map((row) => row.actorName)).toEqual(["andong3-d9956ab1"]);
  expect(dump!.rows.taskHistoryPayloads).toEqual([
    { id: expect.any(String), payload: AMENDED_PAYLOAD },
  ]);
  expect(dump!.rows.pendingMentionActions.map((row) => row.targetHandle)).toEqual([
    "andong3-d9956ab1",
  ]);
  expect(dump!.rows.reminders.map((row) => row.target).sort()).toEqual([
    "@andong3-d9956ab1",
    "@andong3-d9956ab1:abcd1234",
  ]);
});

test.skipIf(skipped)("a second run finds nothing to rename", async () => {
  await seedWorld();
  await renameUsernames(db, async () => {});
  const dumps: UsernameRenameDump[] = [];

  const plan = await renameUsernames(db, async (dump) => {
    dumps.push(dump);
  });

  expect(plan).toEqual([]);
  expect(dumps).toEqual([]);
});

test.skipIf(skipped)("planning and dumping change nothing", async () => {
  await seedWorld();
  const before = await snapshot();

  const { userCount, plan, dump } = await previewUsernameRenames(db);

  expect(userCount).toBe(5);
  expect(plan).toHaveLength(3);
  expect(dump.rows.users).toHaveLength(3);
  expect(await snapshot()).toEqual(before);
});

test.skipIf(skipped)(
  "data that already breaks a rule stops the apply and changes nothing",
  async () => {
    await seedWorld();
    // A mention whose handle is not its person's username, unrelated to any rename.
    await db.messageMention.updateMany({
      where: { actorId: ids.keeper },
      data: { handle: "someone-else" },
    });
    const before = await snapshot();
    let dumped = false;

    const outcome = await renameUsernames(db, async () => {
      dumped = true;
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("stale-mention-handle");
    expect(dumped).toBe(true);
    expect(await snapshot()).toEqual(before);
  },
);

test.skipIf(skipped)(
  "verify reports a person named like a live Agent of their Workspace, and a stale copy",
  async () => {
    await seedWorld();
    await renameUsernames(db, async () => {});
    const first = await db.workspace.findUniqueOrThrow({ where: { slug: "first" } });
    await db.agent.create({
      data: {
        workspaceId: first.id,
        name: "andong3",
        displayName: "late",
        ownerId: ids.owner,
        runtimeConfig: RUNTIME,
      },
    });
    await db.pendingMentionAction.updateMany({ data: { targetHandle: "old-handle" } });

    const violations = await findUsernameViolations(db);

    expect(violations.map((violation) => violation.rule).sort()).toEqual([
      "agent-name",
      "stale-pending-handle",
    ]);
    expect(violations.find((violation) => violation.rule === "agent-name")?.detail).toContain(
      "andong3",
    );
  },
);

test.skipIf(skipped)(
  "checking against a plan also finds an old name still in a history row or a reminder",
  async () => {
    await seedWorld();
    const plan = await planNow();
    await applyUsernameRenames(db, plan);
    expect(await findUsernameViolations(db, plan)).toEqual([]);

    // Copies that appear after the update, as a send racing the rename would leave.
    await db.taskHistoryEvent.updateMany({
      where: { actorName: "andong3" },
      data: { actorName: "andong3-d9956ab1" },
    });
    await db.reminder.updateMany({
      where: { target: "@andong3" },
      data: { target: "@andong3-d9956ab1" },
    });
    await db.taskHistoryEvent.updateMany({
      where: { seq: 4 },
      data: { payload: AMENDED_PAYLOAD },
    });

    const violations = await findUsernameViolations(db, plan);
    expect(violations.map((violation) => violation.rule).sort()).toEqual([
      "stale-history-actor",
      "stale-history-title",
      "stale-reminder-target",
    ]);
    // Without a plan there is no old name to look for.
    expect(await findUsernameViolations(db)).toEqual([]);
  },
);

test.skipIf(skipped)("restoring from the dump puts every username and copy back", async () => {
  await seedWorld();
  const before = await snapshot();
  const dumps: UsernameRenameDump[] = [];
  await renameUsernames(db, async (dump) => {
    dumps.push(dump);
  });
  expect(await snapshot()).not.toEqual(before);

  await restoreUsernames(db, dumps[0]!);

  expect(await snapshot()).toEqual(before);
});

/** A rename applied, and the dump it wrote. */
async function renamedWorld(seedMore?: () => Promise<unknown>) {
  await seedWorld();
  await seedMore?.();
  const before = await snapshot();
  const dumps: UsernameRenameDump[] = [];
  await renameUsernames(db, async (dump) => {
    dumps.push(dump);
  });
  return { before, dump: dumps[0]! };
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

test.skipIf(skipped)(
  "a name taken by a sign-up while the rename runs is reported by name, and nothing changes",
  async () => {
    await seedWorld();
    const before = await snapshot();

    const error = await refusal(
      renameUsernames(db, async () => {
        // A new account takes a name the plan chose, after the plan was made.
        await db.user.create({ data: { username: "andong3" } });
      }),
    );

    expect(error?.name).toBe("UsernameRenameCollision");
    expect(error?.message).toContain("@andong3 was taken by another account while the rename ran");
    expect(error?.message).toContain("nothing was changed");
    expect(error?.message).not.toContain("Invalid `");
    const after = await snapshot();
    // Only the newcomer is new: every other username is as it was.
    expect(after.users.map((user) => user.username).sort()).toEqual(
      [...before.users.map((user) => user.username), "andong3"].sort(),
    );
    expect({ ...after, users: undefined }).toEqual({ ...before, users: undefined });
  },
);

test.skipIf(skipped)("a restore also takes back what was written since the rename", async () => {
  const { before, dump } = await renamedWorld();
  const tasked = await db.task.findFirstOrThrow({ select: { messageId: true } });
  await db.taskHistoryEvent.create({
    data: {
      taskMessageId: tasked.messageId,
      seq: 5,
      eventType: "amended",
      actorType: "user",
      actorName: "andong3",
      payload: { revision: 2, changes: { title: { from: "a", to: "b for @andong3" } } },
    },
  });
  const reminder = await db.reminder.findFirstOrThrow({ where: { target: "@andong3" } });
  await db.reminder.create({
    data: { ...reminder, id: undefined, target: "@ada-3:beef0000", createdAt: undefined },
  });

  await restoreUsernames(db, dump);

  const after = await snapshot();
  // The actor goes back with the person. A title is free text, and the dump lists which ones were
  // rewritten, so one written since the rename is left as its writer wrote it.
  expect(after.history.find((row) => row.seq === 5)).toEqual({
    seq: 5,
    actorType: "user",
    actorName: "andong3-d9956ab1",
    payload: { revision: 2, changes: { title: { from: "a", to: "b for @andong3" } } },
  });
  expect(after.reminders.map((row) => row.target)).toContain("@ada-bbbbbbbb:beef0000");
  expect(after.users).toEqual(before.users);
});

test.skipIf(skipped)(
  "a title that names an Agent, not the renamed person, is left as it is",
  async () => {
    await seedWorld();
    const titles = await seedAgentTitles();

    await renameUsernames(db, async () => {});

    const after = await amendedTitles();
    // The Workspace the person is not in, and the one where a live Agent has the old name.
    expect(after).toContain(titles.newName);
    expect(after).toContain(titles.oldName);
    expect(after).toContain(titles.sharedOldName);
    // The person's own Workspace is rewritten, as before.
    expect(after).toContain("ping @andong3 and @ada-3, not @andong3-d9956ab1x");
    expect(await findUsernameViolations(db)).toEqual([]);
  },
);

test.skipIf(skipped)(
  "a restore writes the dumped titles back by id and leaves every other title alone",
  async () => {
    let titles!: Awaited<ReturnType<typeof seedAgentTitles>>;
    const { dump } = await renamedWorld(async () => {
      titles = await seedAgentTitles();
    });
    const tasked = await db.task.findFirstOrThrow({
      where: { workspace: { slug: "first" } },
      select: { messageId: true },
    });
    // A title written after the rename, naming the person by their new name.
    await db.taskHistoryEvent.create({
      data: {
        taskMessageId: tasked.messageId,
        seq: 6,
        eventType: "amended",
        actorType: "user",
        actorName: "andong3",
        payload: { revision: 3, changes: { title: { from: "x", to: "ping @andong3 again" } } },
      },
    });

    await restoreUsernames(db, dump);

    const after = await amendedTitles();
    // What was rewritten goes back; nothing that was not rewritten is touched.
    expect(after).toContain(AMENDED_PAYLOAD.changes.title.to);
    expect(after).toContain(titles.newName);
    expect(after).toContain(titles.oldName);
    expect(after).toContain(titles.sharedOldName);
    expect(after).toContain("ping @andong3 again");
  },
);

test.skipIf(skipped)(
  "a restore refuses a dump whose user no longer exists, and says so",
  async () => {
    const { dump } = await renamedWorld();
    const after = await snapshot();
    const missing = crypto.randomUUID();
    const forged = {
      ...dump,
      renames: dump.renames.map((rename, index) =>
        index === 0 ? { ...rename, userId: missing } : rename,
      ),
    };

    const error = await refusal(restoreUsernames(db, forged));

    expect(error?.name).toBe("UsernameRestoreRefused");
    expect(error?.message).toContain(missing);
    expect(error?.message).toContain("no longer exists");
    expect(error?.message).toContain("nothing was changed");
    expect(await snapshot()).toEqual(after);
  },
);

test.skipIf(skipped)("a restore refuses when an old name has been taken since", async () => {
  const { dump } = await renamedWorld();
  await db.user.create({ data: { username: "andong3-d9956ab1" } });
  const after = await snapshot();

  const error = await refusal(restoreUsernames(db, dump));

  expect(error?.name).toBe("UsernameRestoreRefused");
  expect(error?.message).toContain("@andong3-d9956ab1");
  expect(error?.message).toContain("taken by another account");
  expect(await snapshot()).toEqual(after);
});

test.skipIf(skipped)(
  "the dump of a rename that rolled back restores nothing, whoever has taken its new names",
  async () => {
    await seedWorld();
    // Pre-existing drift stops the apply after its dump was written.
    await db.messageMention.updateMany({
      where: { actorId: ids.keeper },
      data: { handle: "someone-else" },
    });
    const dumps: UsernameRenameDump[] = [];
    await renameUsernames(db, async (dump) => {
      dumps.push(dump);
    }).catch(() => undefined);
    expect(dumps).toHaveLength(1);
    // A new account takes a name the dump would have given, and writes rows under it.
    const newcomer = await db.user.create({ data: { username: "andong3" } });
    const tasked = await db.task.findFirstOrThrow({ select: { messageId: true } });
    await db.taskHistoryEvent.create({
      data: {
        taskMessageId: tasked.messageId,
        seq: 5,
        eventType: "status_changed",
        actorType: "user",
        actorName: "andong3",
        payload: {},
      },
    });
    const untouched = await snapshot();

    const error = await refusal(restoreUsernames(db, dumps[0]!));

    expect(error?.name).toBe("UsernameRestoreRefused");
    expect(error?.message).toContain("@andong3-d9956ab1 was renamed @andong3");
    expect(error?.message).toContain("that account is @andong3-d9956ab1 now");
    expect(await snapshot()).toEqual(untouched);
    expect((await db.user.findUniqueOrThrow({ where: { id: newcomer.id } })).username).toBe(
      "andong3",
    );
  },
);

const cli = join(webRoot, "scripts/rename-usernames.ts");

async function runCli(args: string[], environment: Record<string, string | undefined>) {
  const child = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: webRoot,
    env: { ...process.env, DATABASE_URL: undefined, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test.skipIf(skipped)(
  "the script: dry run, apply with a dump, verify, and restore, as an operator runs them",
  async () => {
    await seedWorld();
    const before = await snapshot();
    const directory = await mkdtemp(join(tmpdir(), "username-rename-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "dump.json");
    const environment = { DATABASE_URL: scratchUrl };

    // Every mode says which database it is about to use, and never with whom.
    const target = new URL(scratchUrl);
    const targetLine = `database: ${target.hostname}:${target.port}/${scratchName}`;
    const secret = target.password;
    const outputs: string[] = [];
    const run = async (args: string[]) => {
      const result = await runCli(args, environment);
      outputs.push(result.stdout, result.stderr);
      return result;
    };

    const dryRun = await run([]);
    expect(dryRun.stdout.split("\n")[0]).toBe(targetLine);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain(`${ids.andong}  andong3-d9956ab1 → andong3  (email)`);
    expect(dryRun.stdout).toContain("3 of 5 users would be renamed");
    expect(await snapshot()).toEqual(before);

    const withoutDump = await runCli(["--apply"], environment);
    expect(withoutDump.exitCode).not.toBe(0);
    expect(withoutDump.stderr).toContain("--dump");
    expect(await snapshot()).toEqual(before);

    const apply = await run(["--apply", "--dump", dumpPath]);
    expect(apply.stdout.split("\n")[0]).toBe(targetLine);
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain("3 users renamed");
    const dump = JSON.parse(await readFile(dumpPath, "utf8")) as UsernameRenameDump;
    expect(dump.rows.users.map((row) => row.username).sort()).toEqual([
      "9lives",
      "ada-bbbbbbbb",
      "andong3-d9956ab1",
    ]);
    expect((await snapshot()).users.map((user) => user.username).sort()).toEqual([
      "ada-3",
      "andong3",
      "frankan",
      "u9lives",
      "wsowner",
    ]);

    const verify = await run(["--verify"]);
    expect(verify.stdout.split("\n")[0]).toBe(targetLine);
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toContain("no violations");

    const again = await runCli(["--apply", "--dump", dumpPath], environment);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("nothing to rename");

    const restore = await run(["--restore", dumpPath]);
    expect(restore.stdout.split("\n")[0]).toBe(targetLine);
    expect(restore.exitCode).toBe(0);
    expect(await snapshot()).toEqual(before);

    // A dump is the way back, so an apply that would overwrite one changes nothing.
    const overwrite = await run(["--apply", "--dump", dumpPath]);
    expect(overwrite.exitCode).toBe(1);
    expect(overwrite.stderr).toContain("already exists");
    expect(await snapshot()).toEqual(before);

    if (secret) for (const output of outputs) expect(output).not.toContain(secret);
  },
  60_000,
);

test.skipIf(skipped)(
  "the script: an apply that rolls back leaves its dump set aside, and a restore refuses it",
  async () => {
    await seedWorld();
    // Drift that has nothing to do with the rename stops the apply after its dump was written.
    await db.messageMention.updateMany({
      where: { actorId: ids.keeper },
      data: { handle: "someone-else" },
    });
    const before = await snapshot();
    const directory = await mkdtemp(join(tmpdir(), "username-rename-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "dump.json");
    const environment = { DATABASE_URL: scratchUrl };

    const apply = await runCli(["--apply", "--dump", dumpPath], environment);

    expect(apply.exitCode).toBe(1);
    expect(apply.stderr).toContain("stale-mention-handle");
    expect(apply.stderr).toContain("nothing was changed");
    expect(apply.stderr).toContain(join(directory, "dump.failed.json"));
    expect(await snapshot()).toEqual(before);
    expect((await readdir(directory)).sort()).toEqual(["dump.failed.json"]);

    // A new account takes a name the failed dump would have given; restoring it must not touch it.
    await db.user.create({ data: { username: "andong3" } });
    const untouched = await snapshot();
    const restore = await runCli(["--restore", join(directory, "dump.failed.json")], environment);
    expect(restore.exitCode).toBe(1);
    expect(restore.stderr).toContain("nothing was changed");
    expect(await snapshot()).toEqual(untouched);
  },
  60_000,
);
