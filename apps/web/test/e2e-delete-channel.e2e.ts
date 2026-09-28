import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Deleting a channel in a real browser, as a Workspace owner. The channel settings panel's Actions
 * end with a red "Delete channel"; its confirmation warns that the deletion is permanent and
 * confirms with a red "Delete". Someone who lost their owner or admin role meanwhile is told why the
 * delete was refused. Otherwise the viewer lands back in Chat, the channel has left the sidebar,
 * and it and its messages are gone from the database.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace (seed-dev). Each run seeds a fresh channel with one message. Screenshots are
 * written under `.amp/e2e/delete-channel/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/delete-channel");

test("an owner deletes a channel from its settings panel", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `delete-channel-${process.pid}`;
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

  const channelName = `e2e-delete-${process.pid}`;
  const sidebarHasChannel = `[...document.querySelectorAll("a")].some((link) => link.textContent.trim() === ${JSON.stringify(channelName)})`;
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  const workspaceId = membership.workspaceId;
  const ownMembership = { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } };
  const channel = await db.conversation.create({
    data: { workspaceId, channelName, description: "" },
  });
  try {
    const member = await db.conversationMember.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        senderMemberId: member.id,
        sequence: 1,
        body: "about to be deleted",
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/messages/channels/${channel.id}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    await waitFor(sidebarHasChannel);
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
    const panelOpen = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]') !== null`;
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(panelOpen, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
    await waitFor(`${byText("button", "Delete channel")} !== undefined`);
    await browser("screenshot", join(artifacts, "actions.png"));

    await clickText("button", "Delete channel");
    await waitFor(`document.body.textContent.includes("permanently deleted")`);
    await browser("screenshot", join(artifacts, "confirm.png"));

    // Demoted while the dialog is open: the refusal names the reason and the channel stays.
    await db.workspaceMembership.update({ where: ownMembership, data: { role: "member" } });
    await clickText('[role="dialog"] button', "Delete");
    await waitFor(
      `document.querySelector('[role="alert"]')?.textContent.includes("Only a Workspace owner or admin")`,
    );
    await browser("screenshot", join(artifacts, "denied.png"));
    expect(await db.conversation.findUnique({ where: { id: channel.id } })).not.toBeNull();
    await db.workspaceMembership.update({ where: ownMembership, data: { role: "owner" } });

    await clickText('[role="dialog"] button', "Delete");

    await waitFor(`location.pathname !== "/en/messages/channels/${channel.id}"`);
    await waitFor(`!${sidebarHasChannel}`);
    expect(await db.conversation.findUnique({ where: { id: channel.id } })).toBeNull();
    expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(0);
    await browser("screenshot", join(artifacts, "deleted.png"));

    // Opening it by URL afterwards lands back in Chat too.
    await browser("open", `${origin}/en/messages/channels/${channel.id}`);
    await waitFor(`location.pathname !== "/en/messages/channels/${channel.id}"`);
  } finally {
    await db.workspaceMembership
      .update({ where: ownMembership, data: { role: "owner" } })
      .catch(() => {});
    await db.message.deleteMany({ where: { conversationId: channel.id } }).catch(() => {});
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
