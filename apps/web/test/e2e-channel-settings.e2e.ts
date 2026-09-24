import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The channel settings panel in a real browser. The header's gear opens a slideout naming the
 * channel with its Public badge and member summary. A channel admin saves a new description and
 * name from Info. Closing with unsaved edits asks first. Pin and Mute change only the viewer's
 * membership. Archiving (after a confirmation) replaces the composer with an archived notice
 * whose Unarchive brings it back. Leaving (after a confirmation) turns the channel read-only
 * until the viewer rejoins.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel is seeded
 * deterministically and reset on every run. Screenshots are written under
 * `.amp/e2e/channel-settings/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-settings");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the channel settings panel edits info, preferences, archive and membership", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `channel-settings-${process.pid}`;
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
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  const waitFor = (condition: string) => browser("wait", "--fn", condition);
  const channelHeader = `[...document.querySelectorAll("header")].find((header) => header.querySelector("h1")?.textContent.startsWith("#"))`;
  const panelOpen = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]') !== null`;
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(text)})`;
  const clickText = (selector: string, text: string) =>
    browser("eval", `${byText(selector, text)}.click()`);
  async function openPanel() {
    await browser("click", '[aria-label="Channel details and settings"]');
    await waitFor(panelOpen);
  }

  const channelId = seededUuid("e2e-channel-settings:channel");
  const channelName = "e2e-settings";
  const renamed = "e2e-settings-renamed";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const workspaceId = membership.workspaceId;
    // Reset: the viewer created the channel (so is its admin), it is live, unpinned and unmuted.
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
      update: { leftAt: null, channelRole: "admin", channelMuted: false, hiddenAt: null },
      create: {
        conversationId: channelId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await db.conversationPin.deleteMany({ where: { conversationId: channelId } });
    const viewerRow = () =>
      db.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_userId: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
        },
        include: { pins: true },
      });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/messages/channels/${channelId}`);
    await waitFor(`document.querySelector('[aria-label="Channel details and settings"]') !== null`);

    // The header shows only the gear; the old Members and Bell buttons are gone.
    const headerButtons = await evaluate<string[]>(
      `[...${channelHeader}.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent.trim())`,
    );
    expect(headerButtons).toContain("Channel details and settings");
    expect(headerButtons).not.toContain("Members");

    await openPanel();
    await waitFor(`${byText("h3", "Members")} !== undefined`);
    const identity = await evaluate<{ title: string; text: string }>(`(() => {
      const panel = document.querySelector('[role="dialog"][aria-label="Channel details and settings"]');
      return { title: panel.querySelector("h2").textContent, text: panel.textContent };
    })()`);
    expect(identity.title).toBe(`#${channelName}`);
    for (const label of [
      "Public",
      "Members",
      "Info",
      "Preferences",
      "Actions",
      "Archive channel",
      "Leave channel",
    ])
      expect(identity.text).toContain(label);
    await waitFor(`document.querySelector('[role="dialog"]').textContent.includes("1 human")`);
    await browser("screenshot", join(artifacts, "panel.png"));

    // Info: a new description saves and shows under the channel name in the header.
    await browser("fill", '[role="dialog"] textarea', "Where settings get tested");
    await clickText("button", "Save");
    await waitFor(`${byText("button", "Changes saved")} !== undefined`);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).description,
    ).toBe("Where settings get tested");

    // Info: renaming changes the header title.
    await browser("fill", '[role="dialog"] input[type="text"]', renamed);
    await clickText("button", "Save");
    await waitFor(`${channelHeader}?.querySelector("h1").textContent === "#${renamed}"`);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).channelName,
    ).toBe(renamed);

    // Unsaved edits: Escape asks before closing; Discard closes and keeps the saved text.
    await browser("fill", '[role="dialog"] textarea', "Never saved");
    await browser("press", "Escape");
    await waitFor(`${byText("h2", "Unsaved changes")} !== undefined`);
    await browser("screenshot", join(artifacts, "unsaved-prompt.png"));
    await clickText("button", "Discard changes");
    await waitFor(`!(${panelOpen})`);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).description,
    ).toBe("Where settings get tested");

    // Preferences: Pin and Mute change only the viewer's own membership.
    await openPanel();
    await browser("click", '[aria-label="Pin channel"]');
    await waitFor(`document.querySelector('[aria-label="Pin channel"]').checked === true`);
    await browser("click", '[aria-label="Mute activity"]');
    await waitFor(`document.querySelector('[aria-label="Mute activity"]').checked === true`);
    const preferred = await viewerRow();
    expect(preferred.pins.length).toBe(1);
    expect(preferred.channelMuted).toBe(true);

    // Archive: confirm, the panel closes and an archived notice replaces the composer.
    await clickText("button", "Archive channel");
    await waitFor(`${byText("button", "Archive")} !== undefined`);
    await clickText("button", "Archive");
    await waitFor(`document.body.textContent.includes("This channel is archived.")`);
    expect(await evaluate<boolean>(`document.querySelector("main textarea") === null`)).toBe(true);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).archivedAt,
    ).not.toBeNull();
    await browser("screenshot", join(artifacts, "archived.png"));
    await clickText("button", "Unarchive");
    await waitFor(`!document.body.textContent.includes("This channel is archived.")`);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).archivedAt,
    ).toBeNull();

    // Leave: confirm, the channel turns read-only with a Join button; rejoining restores it.
    await openPanel();
    await clickText("button", "Leave channel");
    await waitFor(`${byText("button", "Leave")} !== undefined`);
    await clickText("button", "Leave");
    await waitFor(`${byText("button", "Join channel")} !== undefined`);
    expect((await viewerRow()).leftAt).not.toBeNull();
    await clickText("button", "Join channel");
    await waitFor(`${byText("button", "Join channel")} === undefined`);
    expect((await viewerRow()).leftAt).toBeNull();

    // Phone: the panel covers the screen and still scrolls to its actions.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/messages/channels/${channelId}`);
    await waitFor(`document.querySelector('[aria-label="Channel details and settings"]') !== null`);
    await openPanel();
    const phone = await evaluate<{ panelWidth: number; viewport: number }>(`(() => {
      const panel = document.querySelector('[role="dialog"][aria-label="Channel details and settings"]');
      return { panelWidth: panel.getBoundingClientRect().width, viewport: innerWidth };
    })()`);
    expect(phone.panelWidth).toBeLessThanOrEqual(phone.viewport);
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversationPin.deleteMany({ where: { conversationId: channelId } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
