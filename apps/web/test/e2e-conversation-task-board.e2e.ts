import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * A conversation's Tasks tab is the Tasks page's board scoped to that conversation: the same
 * Filter and Display toolbar and the same cards, without the page header, the source label or
 * Project. Cards carry no Claim or Unclaim button: moving an unowned To do Task to In progress
 * claims it. Done is read in pages of 50 within the finished-work window, as on the Tasks page.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user a member of
 * its Workspace (seed-dev). Each run seeds a fresh channel, Agent and direct message. Screenshots
 * are written under `.amp/e2e/conversation-task-board/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/conversation-task-board");

/** More Done Tasks than one page holds. */
const DONE_COUNT = 52;

test("a conversation's Tasks tab is the Tasks page board, claims by moving and pages Done", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `conversation-task-board-${process.pid}`;
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
  /** Waits for `condition`, failing with its text rather than at the test timeout. */
  const waitFor = async (condition: string, ms = 20_000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        browser("wait", "--fn", condition),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;
  const bodyHas = (text: string) => `document.body.textContent.includes(${JSON.stringify(text)})`;
  const cardsIn = (status: string) =>
    `document.querySelectorAll('section[aria-label=${JSON.stringify(status)}] article').length`;
  const cardOf = (title: string) =>
    `[...document.querySelectorAll('article')].find((card) => card.textContent.includes(${JSON.stringify(title)}))`;
  const eval_ = async (expression: string) => JSON.parse(await browser("eval", expression));

  const suffix = `${process.pid}-${Date.now()}`;
  const channelName = `e2e-board-${suffix}`;
  const openTitle = `Open work ${suffix}`;
  const dragTitle = `Drag work ${suffix}`;
  const directTitle = `Direct work ${suffix}`;
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
  });
  const workspaceId = membership.workspaceId;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-board-agent-${suffix}`,
      displayName: `Board Agent ${suffix}`,
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
      // The key the direct message page looks the conversation up by.
      directKey: `agent:${agent.id}|user:${DEV_BROWSER_USER.id}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  try {
    const board = new TaskBoard(db);
    const as = { workspaceId, userId: DEV_BROWSER_USER.id };
    const command = (conversationId: string, input: Record<string, unknown>) =>
      board.execute(as, {
        idempotencyKey: crypto.randomUUID(),
        conversationId,
        ...input,
      } as Parameters<TaskBoard["execute"]>[1]);
    const doneTitles = Array.from(
      { length: DONE_COUNT },
      (_, index) => `Finished ${index} ${suffix}`,
    );
    const { tasks: done } = await command(channel.id, { operation: "create", titles: doneTitles });
    await command(channel.id, { operation: "claim", numbers: done.map((task) => task.number) });
    for (const task of done)
      await command(channel.id, {
        operation: "update",
        number: task.number,
        status: "done",
      });
    await command(channel.id, { operation: "create", title: openTitle });
    await command(channel.id, { operation: "create", title: dragTitle });
    await command(direct.id, { operation: "create", title: directTitle });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // The channel's Tasks tab: the Tasks page's toolbar, no page header, no source or Claim.
    await browser("open", `${origin}/en/messages/channels/${channel.id}?view=tasks&layout=board`);
    await waitFor(bodyHas(openTitle), 60_000);
    await waitFor(`${byText("button", "Filter")} !== undefined`);
    expect(await eval_(`${byText("button", "Display")} !== undefined`)).toBe(true);
    expect(await eval_(`${byText("button", "Create task")} !== undefined`)).toBe(true);
    expect(await eval_(`${byText("button", "Claim")} === undefined`)).toBe(true);
    expect(
      await eval_(`${cardOf(openTitle)}.textContent.includes(${JSON.stringify(channelName)})`),
    ).toBe(false);

    // Done shows one page of 50 within the week, then the rest on "Load more".
    await waitFor(`${cardsIn("Done")} === 50`);
    await browser("screenshot", join(artifacts, "channel-board.png"));
    await browser("eval", `${byText("button", "Load more")}.click()`);
    await waitFor(`${cardsIn("Done")} === ${DONE_COUNT}`);

    // Moving the unowned To do Task to In progress claims it for the viewer.
    await browser(
      "eval",
      `${cardOf(openTitle)}.querySelector('button[aria-label^="More actions"]').click()`,
    );
    await waitFor(`${byText('[role="menuitem"]', "In progress")} !== undefined`);
    await browser("eval", `${byText('[role="menuitem"]', "In progress")}.click()`);
    await waitFor(
      `[...document.querySelectorAll('section[aria-label="In progress"] article')].some((card) => card.textContent.includes(${JSON.stringify(openTitle)}))`,
    );
    // So does dragging one there by its handle, with a real pointer.
    const centre = async (selector: string) =>
      (await eval_(
        `(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + Math.min(40, box.height / 2))]; })()`,
      )) as [number, number];
    const dragNumber: number = await eval_(
      `Number(${cardOf(dragTitle)}.textContent.match(/#(\\d+)/)[1])`,
    );
    const handle = `button[aria-label="Move task #${dragNumber}"]`;
    await browser("hover", handle);
    const [fromX, fromY] = await centre(handle);
    const [toX, toY] = await centre('section[aria-label="In progress"]');
    await browser("mouse", "move", String(fromX), String(fromY));
    await browser("mouse", "down");
    for (let step = 1; step <= 10; step += 1)
      await browser(
        "mouse",
        "move",
        String(Math.round(fromX + ((toX - fromX) * step) / 10)),
        String(Math.round(fromY + ((toY - fromY) * step) / 10)),
      );
    await browser("mouse", "up");
    await waitFor(
      `[...document.querySelectorAll('section[aria-label="In progress"] article')].some((card) => card.textContent.includes(${JSON.stringify(dragTitle)}))`,
    );
    const claimed = await db.task.findMany({
      where: { conversationId: channel.id, title: { in: [openTitle, dragTitle] } },
      orderBy: { number: "asc" },
      select: { status: true, owner: { select: { userId: true } } },
    });
    expect(claimed).toEqual(
      [openTitle, dragTitle].map(() => ({
        status: "in_progress",
        owner: { userId: DEV_BROWSER_USER.id },
      })),
    );
    await browser("screenshot", join(artifacts, "channel-claimed.png"));

    // A direct message's Tasks tab is the same board.
    await browser("open", `${origin}/en/messages/${agent.id}?view=tasks&layout=board`);
    await waitFor(bodyHas(directTitle), 60_000);
    await waitFor(`${byText("button", "Filter")} !== undefined`);
    expect(await eval_(`${byText("button", "Claim")} === undefined`)).toBe(true);
    await browser("screenshot", join(artifacts, "direct-board.png"));

    // At phone width the tab still fits its toolbar and cards without scrolling sideways.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/messages/channels/${channel.id}?view=tasks`);
    await waitFor(bodyHas(openTitle), 60_000);
    await waitFor(`${byText("button", "Filter")} !== undefined`);
    expect(
      await eval_("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "channel-mobile.png"));
  } finally {
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, direct.id] } } })
      .catch(() => {});
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
