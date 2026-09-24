import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { createAgentDirectTask } from "#src/server/tasks/agent-direct-task.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const short = crypto.randomUUID().slice(0, 8);
const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.$disconnect();
});

/**
 * A person and an Agent may share a name (usernames are global, Agent names per Workspace). An
 * assignee picked in the browser is bound by id, so it is always the one picked; a bare `@name`
 * (the Agent CLI) resolves to the person when both match.
 */
const twin = `twin-${short}`;
let person: { id: string };
let agent: { id: string };
let workspaceId: string;
let channelId: string;
beforeAll(async () => {
  person = await db.user.create({ data: { username: twin } });
  const workspace = await db.workspace.create({
    data: {
      slug: `assignee-${short}`,
      name: "Assignee binding",
      members: { create: { userId: person.id, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  agent = await db.agent.create({
    data: { workspaceId, name: twin, displayName: "Twin", ownerId: person.id, runtimeConfig: {} },
    select: { id: true },
  });
  channelId = (
    await db.conversation.create({
      data: {
        workspaceId,
        channelName: `assignee-${short}`,
        members: { create: [{ userId: person.id }, { agentId: agent.id }] },
      },
    })
  ).id;
  cleanup.push(
    () => db.user.delete({ where: { id: person.id } }),
    () => db.workspace.delete({ where: { id: workspaceId } }),
  );
});

const create = (assignee: string) =>
  new TaskBoard(db).execute(
    { workspaceId, userId: person.id },
    {
      operation: "create",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channelId,
      title: `For ${assignee}`,
      assignee,
    },
  );

test("an assignee bound by id is the one picked, even when a person shares the name", async () => {
  expect((await create(`agent:${agent.id}`)).tasks[0]!.owner).toMatchObject({
    kind: "agent",
    id: agent.id,
  });
  expect((await create(`user:${person.id}`)).tasks[0]!.owner).toMatchObject({
    kind: "user",
    id: person.id,
  });
});

test("a bare @name both could answer to is the person", async () => {
  expect((await create(`@${twin}`)).tasks[0]!.owner).toMatchObject({ kind: "user", id: person.id });
});

test("a Task for an Agent from the Tasks page goes to that Agent, whoever shares its name", async () => {
  const created = await createAgentDirectTask(db, new TaskBoard(db), {
    workspaceId,
    userId: person.id,
    agentId: agent.id,
    title: "Only for the Agent",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(created.tasks[0]!.owner).toMatchObject({ kind: "agent", id: agent.id });
});
