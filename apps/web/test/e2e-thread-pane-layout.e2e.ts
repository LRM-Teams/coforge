import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The thread pane's layout in a real browser: the header names the thread and its channel,
 * its actions sit behind one menu next to Close, the root is followed by a marker saying where
 * the replies begin and how many there are, and the composer invites a thread reply. "View in
 * channel" leaves the thread for its root in the channel. On a phone the pane covers the chat,
 * so a back arrow replaces Close.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`; the thread is seeded
 * deterministically, so reruns restore the same rows instead of duplicating them. Screenshots
 * of the wide and phone layouts are written under `.amp/e2e/thread-pane-layout/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/thread-pane-layout");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the thread pane shows its title, actions, replies marker and thread composer", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `thread-pane-layout-${process.pid}`;
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
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const viewer = await db.conversationMember.findFirstOrThrow({
      where: {
        userId: DEV_BROWSER_USER.id,
        workspaceId: membership.workspaceId,
        leftAt: null,
        conversation: { channelName: { not: null }, archivedAt: null },
      },
      include: { conversation: true },
      orderBy: { conversation: { createdAt: "asc" } },
    });
    const channel = viewer.conversation;
    // A root with two replies — one person, one system notice — at the channel's tail.
    const last = await db.message.aggregate({
      where: { conversationId: channel.id },
      _max: { sequence: true },
    });
    let sequence = (last._max.sequence ?? 0) + 1;
    const rootId = seededUuid("e2e-thread-pane-layout:root");
    const rows = [
      { id: rootId, body: "Thread pane layout root", senderMemberId: viewer.id },
      {
        id: seededUuid("e2e-thread-pane-layout:reply"),
        body: "Thread pane layout reply",
        senderMemberId: viewer.id,
        threadRootId: rootId,
      },
      {
        id: seededUuid("e2e-thread-pane-layout:notice"),
        body: "📌 Thread pane layout notice",
        senderMemberId: null,
        threadRootId: rootId,
      },
    ];
    for (const row of rows) {
      await db.message.upsert({
        where: { id: row.id },
        update: { body: row.body, sequence },
        create: {
          ...row,
          conversationId: channel.id,
          workspaceId: channel.workspaceId,
          sequence,
        },
      });
      sequence += 1;
    }
    await mkdir(artifacts, { recursive: true });
    const threadUrl = `${origin}/en/messages/channels/${channel.id}?threadRootId=${rootId}`;

    await browser("set", "viewport", "1440", "900");
    await browser("open", threadUrl);
    await browser("wait", "--fn", `document.querySelector('[aria-label="Close thread"]') !== null`);
    const wide = await evaluate<{
      title: string;
      closeVisible: boolean;
      backVisible: boolean;
      order: number[];
      placeholder: string | null;
    }>(`(() => {
      const pane = [...document.querySelectorAll('section[aria-label="Thread"]')].find(
        (section) => !section.hidden,
      );
      const visible = (element) => Boolean(element && element.getClientRects().length);
      const text = pane.textContent;
      return {
        title: pane.querySelector("header h2").textContent,
        closeVisible: visible(pane.querySelector('[aria-label="Close thread"]')),
        backVisible: visible(pane.querySelector('[aria-label="Back to chat"]')),
        order: [
          text.indexOf("Thread pane layout root"),
          text.indexOf("Beginning of replies"),
          text.indexOf("2 replies"),
          text.indexOf("Thread pane layout reply"),
        ],
        placeholder: pane.querySelector("textarea")?.getAttribute("placeholder") ?? null,
      };
    })()`);
    expect(wide.title).toBe(`Thread — #${channel.channelName}`);
    expect(wide.closeVisible).toBe(true);
    expect(wide.backVisible).toBe(false);
    expect(wide.order.every((at) => at >= 0)).toBe(true);
    expect([...wide.order].sort((a, b) => a - b)).toEqual(wide.order);
    expect(wide.placeholder).toBe("Message thread");
    await browser("screenshot", join(artifacts, "wide.png"));

    await browser("click", '[aria-label="Thread actions"]');
    await browser("wait", "--fn", `document.querySelectorAll('[role="menuitem"]').length > 0`);
    const items = await evaluate<string[]>(
      `[...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`,
    );
    expect(items[0]).toBe("View in channel");
    expect(items[1]).toMatch(/^(Follow|Unfollow) thread$/);
    await browser("screenshot", join(artifacts, "actions-menu.png"));

    await browser("find", "role", "menuitem", "click", "--name", "View in channel");
    await browser("wait", "--fn", `!location.search.includes("threadRootId")`);
    await browser("wait", "--fn", `document.getElementById("message-${rootId}") !== null`);
    expect(await evaluate<boolean>(`!document.querySelector('[aria-label="Close thread"]')`)).toBe(
      true,
    );

    await browser("set", "viewport", "390", "844");
    await browser("open", threadUrl);
    await browser("wait", "--fn", `document.querySelector('[aria-label="Back to chat"]') !== null`);
    const phone = await evaluate<{ closeVisible: boolean; backVisible: boolean }>(`(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length);
      return {
        closeVisible: visible(document.querySelector('[aria-label="Close thread"]')),
        backVisible: visible(document.querySelector('[aria-label="Back to chat"]')),
      };
    })()`);
    expect(phone).toEqual({ closeVisible: false, backVisible: true });
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 60_000);
