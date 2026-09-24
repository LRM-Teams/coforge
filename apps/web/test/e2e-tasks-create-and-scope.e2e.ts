import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * The Tasks page and a channel's Tasks tab in a real browser. The Tasks page lists channel Tasks
 * and none from a direct message (not even the viewer's own), and offers no way to create a Task.
 * A channel's Tasks tab creates them: the dialog takes titles only, refuses an empty one, and
 * creates every row it holds at once in that channel.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user a member of
 * its Workspace (seed-dev). Each run seeds a fresh channel, Agent and direct message. Screenshots
 * are written under `.amp/e2e/tasks-create-and-scope/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/tasks-create-and-scope");

test("the Tasks page shows channel Tasks only, and a channel's Tasks tab creates several at once", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `tasks-create-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** Waits for `condition`, failing with its text rather than at the test timeout; a first page
   * load compiles on the dev server, so it gets longer. */
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;
  const bodyHas = (text: string) => `document.body.textContent.includes(${JSON.stringify(text)})`;
  const dialogOpen = `document.querySelector('[role="dialog"] input[aria-label="Task 1"]') !== null`;

  const suffix = `${process.pid}-${Date.now()}`;
  const channelTitle = `Channel work ${suffix}`;
  const directTitle = `Direct work ${suffix}`;
  const created = [`First new ${suffix}`, `Second new ${suffix}`];
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
  });
  const workspaceId = membership.workspaceId;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-tasks-${suffix}`,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-tasks-agent-${suffix}`,
      displayName: `Tasks Agent ${suffix}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const direct = await db.conversation.create({
    data: {
      workspaceId,
      directKey: [DEV_BROWSER_USER.id, agent.id].sort().join(":"),
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }],
      },
    },
  });
  try {
    const board = new TaskBoard(db);
    const as = { workspaceId, userId: DEV_BROWSER_USER.id };
    for (const [conversationId, title] of [
      [channel.id, channelTitle],
      [direct.id, directTitle],
    ] as const)
      await board.execute(as, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId,
        title,
      });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // The Tasks page: the channel's Task, not the direct message's, and no "+" to create one.
    await browser("open", `${origin}/en/tasks`);
    await waitFor(bodyHas(channelTitle), 60_000);
    expect(await browser("eval", bodyHas(directTitle))).toContain("false");
    expect(
      await browser(
        "eval",
        `document.querySelectorAll('[aria-label^="New task in"]').length === 0 && ${byText("button", "Create task")} === undefined`,
      ),
    ).toContain("true");
    await browser("screenshot", join(artifacts, "tasks-page.png"));

    // The channel's Tasks tab creates them. A click before hydration opens nothing: retry.
    await browser("open", `${origin}/en/messages/channels/${channel.id}?view=tasks`);
    await waitFor(bodyHas(channelTitle), 60_000);
    for (let attempt = 0; ; attempt += 1) {
      await browser("eval", `${byText("button", "Create task")}?.click()`);
      if (
        await waitFor(dialogOpen, 5_000).then(
          () => true,
          () => false,
        )
      )
        break;
      if (attempt === 5) throw new Error("the create dialog never opened");
    }

    // No title at all is refused in place.
    await browser("eval", `${byText('[role="dialog"] button', "Create task")}.click()`);
    await waitFor(
      `document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes("at least one task title")`,
    );
    await browser("screenshot", join(artifacts, "create-empty.png"));

    await browser("fill", '[role="dialog"] input[aria-label="Task 1"]', created[0]!);
    await browser("eval", `${byText('[role="dialog"] button', "Add another")}.click()`);
    await waitFor(`document.querySelector('[role="dialog"] input[aria-label="Task 2"]') !== null`);
    await browser("fill", '[role="dialog"] input[aria-label="Task 2"]', created[1]!);
    await waitFor(`${byText('[role="dialog"] button', "Create 2 tasks")} !== undefined`);
    await browser("screenshot", join(artifacts, "create-two.png"));
    await browser("eval", `${byText('[role="dialog"] button', "Create 2 tasks")}.click()`);

    // Both land in the channel together, the dialog closes, and the board shows them.
    await waitFor(`!(${dialogOpen})`);
    await waitFor(`${bodyHas(created[0]!)} && ${bodyHas(created[1]!)}`);
    const rows = await db.task.findMany({
      where: { conversationId: channel.id, title: { in: created } },
      orderBy: { number: "asc" },
      select: { title: true, status: true },
    });
    expect(rows).toEqual(created.map((title) => ({ title, status: "todo" })));
    await browser("screenshot", join(artifacts, "created.png"));
  } finally {
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, direct.id] } } })
      .catch(() => {});
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
