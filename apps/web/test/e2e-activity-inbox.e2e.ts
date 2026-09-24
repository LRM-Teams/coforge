import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The Activity page in a real browser: a followed thread with an unread reply that mentions the
 * viewer and a channel with an unread message appear as cards with their badges; the Mentions view
 * keeps only the thread; the card menu offers read, Done and unfollow; Done removes a card for
 * good; opening the thread card lands in its thread pane.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its peer and
 * its messages are seeded deterministically and reset on every run. Screenshots of the wide and
 * phone layouts are written under `.amp/e2e/activity-inbox/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-inbox");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the Activity page lists, filters, marks Done and opens inbox items", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-${process.pid}`;
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
  /** The text of every card this test seeded, in page order. */
  const seededCards = `[...document.querySelectorAll("ol > li")]
    .map((card) => card.textContent)
    .filter((text) => text.includes("E2E activity"))`;
  try {
    const { workspaceId } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const peer = await db.user.upsert({
      where: { id: seededUuid("e2e-activity-inbox:peer") },
      update: {},
      create: {
        id: seededUuid("e2e-activity-inbox:peer"),
        username: "e2e-activity-peer",
        displayName: "Activity Peer",
      },
    });
    await db.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: peer.id } },
      update: {},
      create: { workspaceId, userId: peer.id },
    });
    const channelId = seededUuid("e2e-activity-inbox:channel");
    await db.conversation.upsert({
      where: { id: channelId },
      update: { archivedAt: null },
      create: { id: channelId, workspaceId, channelName: "e2e-activity-inbox" },
    });
    // Every run starts from the same state: no messages, follows or cursors from the last one.
    await db.message.deleteMany({ where: { conversationId: channelId } });
    const [viewer, other] = await Promise.all(
      [DEV_BROWSER_USER.id, peer.id].map((userId) =>
        db.conversationMember.upsert({
          where: { conversationId_userId: { conversationId: channelId, userId } },
          update: {
            leftAt: null,
            readThroughSequence: 0,
            doneThroughSequence: null,
            unreadFromSequence: null,
          },
          create: { conversationId: channelId, workspaceId, userId },
        }),
      ),
    );
    const rootId = seededUuid("e2e-activity-inbox:root");
    const replyId = seededUuid("e2e-activity-inbox:reply");
    const rows = [
      { id: rootId, body: "E2E activity root", senderMemberId: viewer!.id, threadRootId: null },
      {
        id: replyId,
        body: `<@human:${DEV_BROWSER_USER.id}> E2E activity reply`,
        senderMemberId: other!.id,
        threadRootId: rootId,
      },
      {
        id: seededUuid("e2e-activity-inbox:unread"),
        body: "E2E activity unread",
        senderMemberId: other!.id,
        threadRootId: null,
      },
    ];
    let sequence = 1;
    for (const row of rows)
      await db.message.create({
        data: { ...row, conversationId: channelId, workspaceId, sequence: sequence++ },
      });
    await db.messageMention.create({
      data: {
        messageId: replyId,
        memberId: viewer!.id,
        conversationId: channelId,
        workspaceId,
        kind: "user",
        actorId: DEV_BROWSER_USER.id,
        handle: DEV_BROWSER_USER.username,
      },
    });
    await db.threadFollow.create({
      data: { memberId: viewer!.id, rootMessageId: rootId, conversationId: channelId, workspaceId },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/activity`);
    await browser("wait", "--fn", `${seededCards}.length === 2`);
    const cards = await evaluate<string[]>(seededCards);
    // Newest activity first: the channel's unread message was posted after the thread reply.
    expect(cards[0]).toContain("#e2e-activity-inbox");
    expect(cards[0]).toContain("Activity Peer: E2E activity unread");
    expect(cards[0]).toContain("1 new");
    expect(cards[1]).toContain("E2E activity root");
    expect(cards[1]).toContain("1 reply");
    expect(cards[1]).toContain("@you");
    expect(cards[1]).toContain("1 new");
    await browser("screenshot", join(artifacts, "wide.png"));

    await browser("find", "role", "radio", "click", "--name", "Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    await browser("wait", "--fn", `${seededCards}.length === 1`);
    expect((await evaluate<string[]>(seededCards))[0]).toContain("E2E activity root");
    await browser("find", "role", "radio", "click", "--name", "All");
    await browser("wait", "--fn", `${seededCards}.length === 2`);

    // The card menu opens on a right click (a long press on touch).
    await evaluate(`(() => {
      const card = [...document.querySelectorAll("ol > li")].find((item) =>
        item.textContent.includes("E2E activity root"));
      const link = card.querySelector("a");
      const box = link.getBoundingClientRect();
      link.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 10,
      }));
      return true;
    })()`);
    await browser("wait", "--fn", `document.querySelectorAll('[role="menuitem"]').length > 0`);
    const menu = await evaluate<string[]>(
      `[...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`,
    );
    expect(menu).toEqual(["Mark as Read", "Done", "Unfollow thread"]);
    await browser("screenshot", join(artifacts, "card-menu.png"));
    await browser("press", "Escape");

    await evaluate(`(() => {
      const card = [...document.querySelectorAll("ol > li")].find((item) =>
        item.textContent.includes("E2E activity unread"));
      card.querySelector('[aria-label="Mark as Done"]').click();
      return true;
    })()`);
    await browser("wait", "--fn", `${seededCards}.length === 1`);
    await browser("reload");
    await browser("wait", "--fn", `${seededCards}.length === 1`);
    expect((await evaluate<string[]>(seededCards))[0]).toContain("E2E activity root");

    await browser("find", "text", "E2E activity root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${rootId}")`);
    expect(await evaluate<string>("location.pathname")).toBe(`/en/messages/channels/${channelId}`);

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/activity`);
    await browser("wait", "--fn", `${seededCards}.length === 1`);
    // Opening the thread read it: its card stays, without the unread badge.
    expect((await evaluate<string[]>(seededCards))[0]).not.toContain("1 new");
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
