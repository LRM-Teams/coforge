import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The "Collapse long messages" preference in a real browser. A very long message in a channel
 * folds behind "Show more" by default; turning the preference off in the channel's settings panel
 * shows it in full, for this member in this channel only, and turning it back on folds it again.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace (seed-dev). Each run seeds a fresh channel with one long message and removes it
 * afterwards. Screenshots are written under `.amp/e2e/collapse-long-messages/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/collapse-long-messages");

test("a member turns off collapsing long messages for one channel and back on", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `collapse-long-messages-${process.pid}`;
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
  const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
  /** A click that lands before the page hydrates opens nothing; try again until the panel opens. */
  async function openSettings() {
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(`${panel} !== null`, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) return;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
  }

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  const workspaceId = membership.workspaceId;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-collapse-${process.pid}`, description: "" },
  });
  const showMore = `[...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Show more")`;
  try {
    const member = await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        senderMemberId: member.id,
        sequence: 1,
        body: Array.from({ length: 40 }, (_, line) => `Line ${line + 1} of a long message.`).join(
          "\n\n",
        ),
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/messages/channels/${channel.id}`);
    await waitFor(showMore, 60_000);
    await browser("screenshot", join(artifacts, "collapsed.png"));

    await openSettings();
    // The switch carries its own label; React Aria puts the input inside the labelled element.
    const toggle = `((el) => el && (el.tagName === "INPUT" ? el : el.querySelector("input")))(${panel}?.querySelector('[aria-label="Collapse long messages"]'))`;
    await waitFor(`${toggle}?.checked === true`);
    await browser("eval", `${toggle}.click()`);
    await waitFor(`${toggle}?.checked === false`);
    const stored = async () =>
      (
        await db.conversationMember.findUniqueOrThrow({
          where: {
            conversationId_userId: { conversationId: channel.id, userId: DEV_BROWSER_USER.id },
          },
        })
      ).collapseLongMessages;
    await browser("press", "Escape");
    await waitFor(`!${showMore}`);
    expect(await stored()).toBe(false);
    await browser("screenshot", join(artifacts, "full.png"));

    // Back on, the message folds again.
    await openSettings();
    await browser("eval", `${toggle}.click()`);
    await waitFor(`${toggle}?.checked === true`);
    await browser("press", "Escape");
    await waitFor(showMore);
    expect(await stored()).toBe(true);
  } finally {
    await db.message.deleteMany({ where: { conversationId: channel.id } }).catch(() => {});
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
