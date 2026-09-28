import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * A channel renamed, described, archived or unarchived in one tab reaches another open tab
 * without a reload: its sidebar row and its open channel page follow the change live.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, and this one also needs
 * browser realtime: Centrifugo reachable at the page's `/connection/websocket` and the Web's
 * browser-token signing key configured, as the managed E2E stack provides behind
 * `scripts/e2e/same-origin-proxy.ts` (`COFORGE_E2E_WEB_URL=http://127.0.0.1:8790`). The channel is seeded deterministically and reset on
 * every run. Screenshots are written under `.amp/e2e/channel-settings-realtime/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-settings-realtime");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function tab(session: string) {
  async function run(...args: string[]) {
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
  return {
    run,
    /** Waits for `condition`, failing with its text after 20 s rather than at the test timeout. */
    waitFor: (condition: string) =>
      Promise.race([
        run("wait", "--fn", condition),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${session}: timed out waiting for ${condition}`)),
            20_000,
          ),
        ),
      ]),
    clickText: async (selector: string, text: string) => {
      const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(text)})`;
      await run("wait", "--fn", `${find} !== undefined`);
      const clicked = await run(
        "eval",
        `(() => { const target = ${find}; target?.click(); return Boolean(target); })()`,
      );
      if (!clicked.includes("true")) throw new Error(`"${text}" disappeared before it was clicked`);
    },
  };
}

const channelHeader = `[...document.querySelectorAll("header")].find((header) => header.querySelector("h1")?.textContent.startsWith("#"))`;
const sidebarHas = (name: string) =>
  `[...document.querySelectorAll("a")].some((link) => link.textContent.trim() === ${JSON.stringify(name)})`;
const panelOpen = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]') !== null`;

test("another open tab follows a channel's rename, description and archive live", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const editor = tab(`channel-realtime-editor-${process.pid}`);
  const watcher = tab(`channel-realtime-watcher-${process.pid}`);
  const channelId = seededUuid("e2e-channel-settings-realtime:channel");
  const channelName = "e2e-live";
  const renamed = "e2e-live-renamed";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: renamed, NOT: { id: channelId } },
    });
    await db.conversation.upsert({
      where: { id: channelId },
      update: { channelName, description: "", archivedAt: null },
      create: { id: channelId, workspaceId, channelName, description: "" },
    });
    await db.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: channelId, userId: DEV_BROWSER_USER.id } },
      update: { leftAt: null, channelRole: "admin", hiddenAt: null },
      create: {
        conversationId: channelId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await mkdir(artifacts, { recursive: true });
    const url = `${origin}/en/messages/channels/${channelId}`;
    for (const browser of [editor, watcher]) {
      await browser.run("set", "viewport", "1440", "900");
      await browser.run("open", url);
      await browser.waitFor(
        `${channelHeader}?.querySelector("h1").textContent === "#${channelName}"`,
      );
    }

    // Rename and describe in the editor tab.
    await editor.run("click", '[aria-label="Channel details and settings"]');
    await editor.waitFor(panelOpen);
    await editor.run("fill", '[role="dialog"] input[type="text"]', renamed);
    await editor.run("fill", '[role="dialog"] textarea', "Followed live");
    await editor.clickText("button", "Save");
    await editor.waitFor(`${channelHeader}?.querySelector("h1").textContent === "#${renamed}"`);

    // The watcher never reloads: its header and sidebar row follow.
    await watcher.waitFor(`${channelHeader}?.querySelector("h1").textContent === "#${renamed}"`);
    await watcher.waitFor(`${channelHeader}.textContent.includes("Followed live")`);
    await watcher.waitFor(sidebarHas(renamed));
    expect(await watcher.run("eval", sidebarHas(channelName))).toContain("false");
    await watcher.run("screenshot", join(artifacts, "renamed.png"));

    // Archive in the editor tab: the watcher's composer turns into the archived notice and the
    // row leaves its sidebar.
    await editor.clickText("button", "Archive channel");
    await editor.waitFor(
      `[...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Archive")`,
    );
    await editor.clickText("button", "Archive");
    await watcher.waitFor(`document.body.textContent.includes("This channel is archived.")`);
    await watcher.waitFor(`!${sidebarHas(renamed)}`);
    await watcher.run("screenshot", join(artifacts, "archived.png"));

    // Unarchive from the editor's notice → panel: the watcher's composer comes back.
    await editor.waitFor(`document.body.textContent.includes("This channel is archived.")`);
    await editor.clickText("button", "Unarchive");
    await editor.waitFor(panelOpen);
    await editor.clickText("button", "Unarchive channel");
    await watcher.waitFor(`!document.body.textContent.includes("This channel is archived.")`);
    await watcher.waitFor(sidebarHas(renamed));
  } catch (error) {
    // Keep what each tab showed when it failed.
    await editor.run("screenshot", join(artifacts, "failure-editor.png")).catch(() => undefined);
    await watcher.run("screenshot", join(artifacts, "failure-watcher.png")).catch(() => undefined);
    throw error;
  } finally {
    await editor.run("close").catch(() => undefined);
    await watcher.run("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
