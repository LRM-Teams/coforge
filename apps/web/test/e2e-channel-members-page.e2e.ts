import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * A channel's members as a page inside its settings panel, in a real browser. The Members summary
 * opens the page in place of the settings (Back returns to them): the members grouped by humans
 * and Agents, a search that narrows them, and "Add member", which opens the add view in the same
 * page. Picking an Agent there and adding it puts it in the list; making it a channel admin
 * changes its role; removing it again asks first, and nothing changes before the confirmation.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace with a Computer attached (seed-dev). Each run seeds a fresh channel with one fresh
 * Agent in it and another outside it, and removes them afterwards. Screenshots are written under
 * `.amp/e2e/channel-members-page/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-members-page");

test("the settings panel shows a channel's members as a page, adds and removes one", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `channel-members-page-${process.pid}`;
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
  async function clickText(selector: string, text: string) {
    await waitFor(`${byText(selector, text)} !== undefined`);
    const clicked = await browser(
      "eval",
      `(() => { const target = ${byText(selector, text)}; target?.click(); return Boolean(target); })()`,
    );
    if (!clicked.includes("true")) throw new Error(`"${text}" disappeared before it was clicked`);
  }
  const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
  const panelHas = (text: string) => `${panel}?.textContent.includes(${JSON.stringify(text)})`;
  const onRoster = `${panel}?.querySelector('input[placeholder="Search members…"]') != null`;

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  const workspaceId = membership.workspaceId;
  const attached = await db.workspaceComputer.findFirstOrThrow({
    where: { workspaceId, computer: { ownerId: DEV_BROWSER_USER.id } },
  });
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-members-${process.pid}`, description: "" },
  });
  const agent = (name: string) =>
    db.agent.create({
      data: {
        workspaceId,
        name: `e2e-members-${name}-${process.pid}`,
        displayName: `Members ${name} ${process.pid}`,
        ownerId: DEV_BROWSER_USER.id,
        computerId: attached.computerId,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
  const [inside, outside] = await Promise.all([agent("inside"), agent("outside")]);
  const agentIds = [inside.id, outside.id];
  try {
    await db.conversationMember.createMany({
      data: [
        {
          conversationId: channel.id,
          workspaceId,
          userId: DEV_BROWSER_USER.id,
          channelRole: "admin",
        },
        { conversationId: channel.id, workspaceId, agentId: inside.id },
      ],
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/messages/channels/${channel.id}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(`${panel} !== null`, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }

    // The Members summary opens the page in place of the settings.
    await clickText(`[role="dialog"] button`, "1 human · 1 agent");
    await waitFor(`${onRoster} && !${panelHas("Preferences")}`);
    await waitFor(panelHas(inside.displayName));
    await browser("screenshot", join(artifacts, "members.png"));

    // The search narrows the list.
    await browser("fill", 'input[placeholder="Search members…"]', "nobody-matches-this");
    await waitFor(`!${panelHas(inside.displayName)}`);
    await browser("fill", 'input[placeholder="Search members…"]', inside.displayName);
    await waitFor(panelHas(inside.displayName));

    // Add member opens the add view in the same page.
    await clickText(`[role="dialog"] button`, "Add member");
    await waitFor(panelHas("Add selected (0)"));
    await browser("fill", 'input[placeholder="Name"]', outside.displayName);
    // The candidate's label also holds its avatar initial and description.
    const candidate = `[...document.querySelectorAll('[role="dialog"] label')].find((label) => label.textContent.includes(${JSON.stringify(outside.displayName)}))`;
    await waitFor(`${candidate} !== undefined`);
    // Each candidate row is valid markup: its avatar is not inside a paragraph.
    expect(await browser("eval", `${panel}.querySelectorAll("p div").length`)).toContain("0");
    await browser("eval", `${candidate}.querySelector("input").click()`);
    await waitFor(panelHas("Add selected (1)"));
    await browser("screenshot", join(artifacts, "add.png"));
    await clickText(`[role="dialog"] button`, "Add selected (1)");
    await waitFor(`${onRoster} && ${panelHas(outside.displayName)}`);
    expect(
      await db.conversationMember.findFirst({
        where: { conversationId: channel.id, agentId: outside.id, leftAt: null },
      }),
    ).not.toBeNull();

    // A channel admin makes the new member a channel admin.
    await browser(
      "eval",
      `document.querySelector(${JSON.stringify(`[aria-label="Make ${outside.displayName} a channel admin"]`)}).click()`,
    );
    await waitFor(
      `document.querySelector(${JSON.stringify(`[aria-label="Remove channel admin from ${outside.displayName}"]`)}) !== null`,
    );
    expect(
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: channel.id, agentId: outside.id },
        })
      ).channelRole,
    ).toBe("admin");

    // Removing asks first.
    await browser(
      "eval",
      `document.querySelector(${JSON.stringify(`[aria-label="Remove ${outside.displayName}"]`)}).click()`,
    );
    await waitFor(`document.body.textContent.includes("Remove member")`);
    await browser("screenshot", join(artifacts, "remove.png"));
    expect(
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: channel.id, agentId: outside.id },
        })
      ).leftAt,
    ).toBeNull();
    await clickText('[role="dialog"] button', "Remove");
    await waitFor(`!${panelHas(outside.displayName)}`);
    expect(
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: channel.id, agentId: outside.id },
        })
      ).leftAt,
    ).not.toBeNull();

    // An Agent's row opens its profile inside the panel; Back returns to the members with the
    // search kept and focus on the row that opened it.
    const openProfile = `[aria-label="Open ${inside.displayName}'s profile"]`;
    const search = `${panel}?.querySelector('input[placeholder="Search members…"]')`;
    await browser("fill", 'input[placeholder="Search members…"]', inside.displayName);
    await browser("eval", `document.querySelector(${JSON.stringify(openProfile)}).click()`);
    await waitFor(`${panel}?.querySelector('[role="tablist"]') != null && !${onRoster}`);
    await waitFor(panelHas(inside.displayName));
    await browser("screenshot", join(artifacts, "profile.png"));
    await browser("eval", `document.querySelector('[aria-label="Back to members"]').click()`);
    await waitFor(
      `${search}?.value === ${JSON.stringify(inside.displayName)} && document.activeElement?.matches(${JSON.stringify(openProfile)})`,
    );

    // Back returns to the settings.
    await browser("eval", `document.querySelector('[aria-label="Back"]').click()`);
    await waitFor(panelHas("Preferences"));

    // Close from the profile closes the whole panel; the next opening starts on the settings.
    await clickText(`[role="dialog"] button`, "1 human · 1 agent");
    await waitFor(`${search}?.value === ""`);
    await browser("eval", `document.querySelector(${JSON.stringify(openProfile)}).click()`);
    await waitFor(`${panel}?.querySelector('[role="tablist"]') != null`);
    await browser("eval", `${panel}.querySelector('[aria-label="Close"]').click()`);
    await waitFor(`${panel} === null`);
    await browser("click", '[aria-label="Channel details and settings"]');
    await waitFor(`${panelHas("Preferences")} && !${onRoster}`);
  } finally {
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    await db.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
