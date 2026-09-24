import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Hiding #general in a real browser, as a Workspace owner. The channel settings panel's Actions
 * offer "Hide #general"; after its confirmation the viewer lands back in Chat and #general has
 * left the sidebar, and opening it by URL lands back in Chat too. Settings → System channels shows
 * "Hide #general channel" ticked; unticking it and saving brings #general back.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace (seed-dev). #general is restored before and after. Screenshots are written under
 * `.amp/e2e/hide-general/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/hide-general");

test("an owner hides #general from its panel and restores it from System channels", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `hide-general-${process.pid}`;
  async function browser(...args: string[]) {
    if (Bun.env.COFORGE_E2E_TRACE) console.error(new Date().toISOString(), args[0], args[1] ?? "");
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
  async function clickText(selector: string, text: string) {
    const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(text)})`;
    await waitFor(`${find} !== undefined`);
    const clicked = await browser(
      "eval",
      `(() => { const target = ${find}; target?.click(); return Boolean(target); })()`,
    );
    if (!clicked.includes("true")) throw new Error(`"${text}" disappeared before it was clicked`);
  }
  const sidebarHasGeneral = `[...document.querySelectorAll("a")].some((link) => link.textContent.trim() === "general")`;

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  const general = await db.conversation.findUniqueOrThrow({
    where: {
      workspaceId_channelName: { workspaceId: membership.workspaceId, channelName: "general" },
    },
  });
  const restore = () =>
    db.conversation.update({ where: { id: general.id }, data: { hiddenFromWorkspaceAt: null } });
  try {
    await restore();
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/messages/channels/${general.id}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
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
    await clickText("button", "Hide #general");
    await waitFor(`document.body.textContent.includes("including you")`);
    await browser("screenshot", join(artifacts, "confirm.png"));
    // The dialog's own confirm button carries the same label as the action.
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="dialog"] button')].filter((b) => b.textContent.trim() === "Hide #general").at(-1).click()`,
    );
    await waitFor(`location.pathname !== "/en/messages/channels/${general.id}"`);
    await waitFor(`!${sidebarHasGeneral}`);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: general.id } }))
        .hiddenFromWorkspaceAt,
    ).not.toBeNull();
    await browser("screenshot", join(artifacts, "hidden.png"));

    // Opening it by URL while hidden also lands back in Chat.
    await browser("open", `${origin}/en/messages/channels/${general.id}`);
    await waitFor(`location.pathname !== "/en/messages/channels/${general.id}"`);

    await browser("open", `${origin}/en/settings?section=system-channels`);
    await waitFor(`document.body.textContent.includes("Hide #general channel")`, 60_000);
    expect(
      await browser("eval", `document.querySelector('input[type="checkbox"]').checked`),
    ).toContain("true");
    await browser("screenshot", join(artifacts, "system-channels.png"));
    await browser("click", 'label:has(input[type="checkbox"])');
    await clickText("button", "Save");
    // Saved once the form matches the stored setting again: the box unticked, Save disabled.
    await waitFor(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save")?.disabled`,
    );
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: general.id } }))
        .hiddenFromWorkspaceAt,
    ).toBeNull();

    await browser("open", `${origin}/en/messages`);
    await waitFor(sidebarHasGeneral);
    // Opening it within the app after the restore shows it, rather than bouncing back to Chat.
    await browser(
      "eval",
      `[...document.querySelectorAll("a")].find((link) => link.textContent.trim() === "general").click()`,
    );
    await waitFor(`location.pathname === "/en/messages/channels/${general.id}"`);
    await waitFor(
      `[...document.querySelectorAll("header h1")].some((h1) => h1.textContent === "#general")`,
      30_000,
    );
  } finally {
    await restore().catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
