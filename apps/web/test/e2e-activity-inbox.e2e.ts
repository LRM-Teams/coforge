import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The Activity page in a real browser: a followed thread with an unread reply that mentions the
 * viewer and a channel with an unread message appear as cards with their badges and Markdown
 * previews; the Mentions view
 * keeps only the thread; the card menu offers read, Done and unfollow; Done removes a card for
 * good; opening the thread card lands in its thread pane at the first unread reply, and a thread
 * read to the end opens at its newest reply. A direct message with a member, and the viewer's with
 * themself, list under that member's name and face, and opening one reads it.
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

/**
 * TanStack Start has hydrated the page: its SSR bootstrap (`$_TSR`) is marked hydrated, and
 * deleted once the stream has also ended. Server-rendered cards already satisfy the card waits,
 * and a click before hydration lands on inert HTML.
 */
const hydrated = `(!window.$_TSR || window.$_TSR.hydrated === true)`;

/** One agent-browser session: its commands, and a page expression read back as JSON. */
function browserSession(session: string) {
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
  return { browser, evaluate };
}

test("the Activity page lists, filters, marks Done and opens inbox items", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-${process.pid}`;
  const { browser, evaluate } = browserSession(session);
  /** The text of every card this test seeded, in page order. */
  const seededCards = `[...document.querySelectorAll("ol > li")]
    .map((card) => card.textContent)
    .filter((text) => text.includes("E2E activity"))`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${workspace.slug}`;
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
        body: `<@human:${DEV_BROWSER_USER.id}> E2E activity **reply** with \`code\``,
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
    // A second channel with a followed thread the viewer has read to the end, where nothing
    // mentions them. The channel itself is Done, so only the thread card lists.
    const quietChannelId = seededUuid("e2e-activity-inbox:quiet-channel");
    await db.conversation.upsert({
      where: { id: quietChannelId },
      update: { archivedAt: null },
      create: { id: quietChannelId, workspaceId, channelName: "e2e-activity-quiet" },
    });
    await db.message.deleteMany({ where: { conversationId: quietChannelId } });
    const quietViewer = await db.conversationMember.upsert({
      where: {
        conversationId_userId: { conversationId: quietChannelId, userId: DEV_BROWSER_USER.id },
      },
      update: {
        leftAt: null,
        readThroughSequence: 1,
        doneThroughSequence: 1,
        unreadFromSequence: null,
      },
      create: {
        conversationId: quietChannelId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        readThroughSequence: 1,
        doneThroughSequence: 1,
      },
    });
    const quietRootId = seededUuid("e2e-activity-inbox:quiet-root");
    const quietNewestId = seededUuid("e2e-activity-inbox:quiet-newest");
    // Enough replies that the thread pane scrolls: the newest one is out of view at the root.
    const quietRows = [
      { id: quietRootId, body: "E2E quiet root", threadRootId: null },
      ...Array.from({ length: 39 }, (_, index) => ({
        id: seededUuid(`e2e-activity-inbox:quiet-reply-${index}`),
        body: `E2E quiet reply ${index + 1}`,
        threadRootId: quietRootId,
      })),
      { id: quietNewestId, body: "E2E quiet newest reply", threadRootId: quietRootId },
    ];
    for (const [index, row] of quietRows.entries())
      await db.message.create({
        data: {
          ...row,
          senderMemberId: quietViewer.id,
          conversationId: quietChannelId,
          workspaceId,
          sequence: index + 1,
        },
      });
    await db.threadFollow.create({
      data: {
        memberId: quietViewer.id,
        rootMessageId: quietRootId,
        conversationId: quietChannelId,
        workspaceId,
      },
    });
    await db.threadRead.create({
      data: {
        memberId: quietViewer.id,
        rootMessageId: quietRootId,
        conversationId: quietChannelId,
        workspaceId,
        readThroughSequence: quietRows.length,
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${seededCards}.length === 2 && ${hydrated}`);
    const cards = await evaluate<string[]>(seededCards);
    // Newest activity first: the channel's unread message was posted after the thread reply.
    expect(cards[0]).toContain("#e2e-activity-inbox");
    expect(cards[0]).toContain("Activity Peer: E2E activity unread");
    expect(cards[0]).toContain("1 new");
    expect(cards[1]).toContain("E2E activity root");
    expect(cards[1]).toContain("1 reply");
    expect(cards[1]).toContain("@you");
    expect(cards[1]).toContain("1 new");
    // The preview renders Markdown inline: the mention as a chip, emphasis and code as markup.
    const preview = await evaluate<{ strong: string | null; code: string | null }>(`(() => {
      const card = [...document.querySelectorAll("ol > li")].find((item) =>
        item.textContent.includes("E2E activity root"));
      return {
        strong: card.querySelector("strong")?.textContent ?? null,
        code: card.querySelector("code")?.textContent ?? null,
      };
    })()`);
    expect(preview).toEqual({ strong: "reply", code: "code" });
    // The Unread and Mentions tabs count cards: both seeded cards are unread, and the thread's
    // reply is an unread mention. Other rows of the dev user's inbox may add to both.
    const tabCounts = `Object.fromEntries([...document.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent.replace(/[\\d+]/g, "").trim(), Number(tab.textContent.replace(/\\D/g, "")) || 0]))`;
    const counts = await evaluate<Record<string, number>>(tabCounts);
    expect(Object.keys(counts)).toEqual(["All", "Unread", "Mentions"]);
    expect(counts.All).toBe(0);
    expect(counts.Unread).toBeGreaterThanOrEqual(2);
    expect(counts.Mentions).toBeGreaterThanOrEqual(1);
    await browser("screenshot", join(artifacts, "wide.png"));

    await browser("find", "role", "tab", "click", "--name", "Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    await browser("wait", "--fn", `${seededCards}.length === 1`);
    expect((await evaluate<string[]>(seededCards))[0]).toContain("E2E activity root");
    // The counts do not depend on the tab showing.
    expect(await evaluate<Record<string, number>>(tabCounts)).toEqual(counts);
    await browser("find", "role", "tab", "click", "--name", "All");
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

    // Read and unread from the card menu move the badge both ways.
    const channelMenu = (label: string) =>
      evaluate(`(() => {
        const card = [...document.querySelectorAll("ol > li")].find((item) =>
          item.textContent.includes("E2E activity unread"));
        const link = card.querySelector("a");
        const box = link.getBoundingClientRect();
        link.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 10,
        }));
        return true;
      })()`)
        .then(() =>
          // This menu's own item: the previous menu may still be closing.
          browser(
            "wait",
            "--fn",
            `[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.trim() === ${JSON.stringify(label)})`,
          ),
        )
        .then(() =>
          evaluate(`[...document.querySelectorAll('[role="menuitem"]')]
            .find((item) => item.textContent.trim() === ${JSON.stringify(label)})
            .click() ?? true`),
        );
    // One line: a wait expression is passed to the browser CLI as a single argument.
    const channelCard = `[...document.querySelectorAll("ol > li")].find((item) => item.textContent.includes("E2E activity unread")).textContent`;
    await channelMenu("Mark as Read");
    await browser("wait", "--fn", `!${channelCard}.includes("1 new")`);
    await browser("wait", "--fn", `${tabCounts}.Unread === ${counts.Unread - 1}`);
    await channelMenu("Mark as Unread");
    await browser("wait", "--fn", `${channelCard}.includes("1 new")`);
    await browser("wait", "--fn", `${tabCounts}.Unread === ${counts.Unread}`);
    expect(await evaluate<boolean>(`!document.querySelector('[role="alert"]')`)).toBe(true);

    await evaluate(`(() => {
      const card = [...document.querySelectorAll("ol > li")].find((item) =>
        item.textContent.includes("E2E activity unread"));
      card.querySelector('[aria-label="Mark as Done"]').click();
      return true;
    })()`);
    await browser("wait", "--fn", `${seededCards}.length === 1`);
    // Done took an unread card away, and the Unread count with it.
    await browser("wait", "--fn", `${tabCounts}.Unread === ${counts.Unread - 1}`);
    await browser("reload");
    await browser("wait", "--fn", `${seededCards}.length === 1 && ${hydrated}`);
    expect((await evaluate<string[]>(seededCards))[0]).toContain("E2E activity root");

    await browser("find", "text", "E2E activity root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${rootId}")`);
    // The pane scrolls to the first unread reply.
    await browser("wait", "--fn", `document.getElementById("message-${replyId}") !== null`);
    expect(await evaluate<string>("location.pathname")).toBe(
      `${workspacePath}/channel/${channelId}`,
    );

    // A thread read to the end with no mention opens at its newest reply.
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "wait",
      "--fn",
      `document.body.textContent.includes("E2E quiet root") && ${hydrated}`,
    );
    await browser("find", "text", "E2E quiet root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${quietRootId}")`);
    // The newest reply sits inside the visible part of the scrolled thread pane.
    await browser(
      "wait",
      "--fn",
      `(() => {
        const row = document.getElementById("message-${quietNewestId}");
        let pane = row?.parentElement;
        while (pane && !(pane.scrollHeight > pane.clientHeight && getComputedStyle(pane).overflowY !== "visible"))
          pane = pane.parentElement;
        if (!row || !pane || pane.scrollTop === 0) return false;
        const rowBox = row.getBoundingClientRect();
        const paneBox = pane.getBoundingClientRect();
        return rowBox.top >= paneBox.top && rowBox.bottom <= paneBox.bottom;
      })()`.replace(/\n\s*/g, " "),
    );

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${seededCards}.length === 1 && ${hydrated}`);
    // Opening the thread read it: its card stays, without the unread badge.
    expect((await evaluate<string[]>(seededCards))[0]).not.toContain("1 new");
    // On a phone the tabs take their own row under the title.
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="tablist"]').getBoundingClientRect().top >= document.querySelector("h1").getBoundingClientRect().bottom`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);

test("a direct message with a member, and the one with themself, list with the member's face and name", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-dm-${process.pid}`;
  const { browser, evaluate } = browserSession(session);
  /** One seeded card's text and avatar initial, found by a message it previews. */
  const card = (text: string) =>
    `(() => { const card = [...document.querySelectorAll("ol > li")].find((item) => item.textContent.includes(${JSON.stringify(text)})); return card ? { text: card.textContent, avatar: card.querySelector("[data-avatar]")?.textContent ?? null } : null; })()`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${workspace.slug}`;
    const peer = await db.user.upsert({
      where: { id: seededUuid("e2e-activity-inbox:dm-peer") },
      update: {},
      create: {
        id: seededUuid("e2e-activity-inbox:dm-peer"),
        username: "e2e-activity-dm-peer",
        displayName: "Activity DM Peer",
      },
    });
    await db.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: peer.id } },
      update: {},
      create: { workspaceId, userId: peer.id },
    });
    const viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
    const viewerName = viewer.displayName?.trim() || viewer.username;
    /** A DM between people and each member's row in it, with the viewer's Done cursor cleared. */
    async function directConversation(key: string, otherUserId: string) {
      const directKey = peopleDirectKey(DEV_BROWSER_USER.id, otherUserId);
      const conversation = await db.conversation.upsert({
        where: { workspaceId_directKey: { workspaceId, directKey } },
        update: {},
        create: { id: seededUuid(key), workspaceId, directKey },
      });
      const members = await Promise.all(
        [...new Set([DEV_BROWSER_USER.id, otherUserId])].map((userId) =>
          db.conversationMember.upsert({
            where: { conversationId_userId: { conversationId: conversation.id, userId } },
            update: { leftAt: null, hiddenAt: null, doneThroughSequence: null },
            create: { conversationId: conversation.id, workspaceId, userId },
          }),
        ),
      );
      return { conversationId: conversation.id, members };
    }
    /** Posts this run's copy of a seeded message as the conversation's newest. */
    async function post(conversationId: string, key: string, senderMemberId: string, body: string) {
      const id = seededUuid(key);
      await db.message.deleteMany({ where: { id } });
      const newest = await db.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      await db.message.create({
        data: {
          id,
          conversationId,
          workspaceId,
          senderMemberId,
          body,
          sequence: (newest?.sequence ?? 0) + 1,
        },
      });
      return id;
    }
    // The peer is this test's own, so their DM starts empty and unread on every run. The viewer's
    // DM with themself is theirs: only this test's note is replaced.
    const withPeer = await directConversation("e2e-activity-inbox:dm", peer.id);
    await db.message.deleteMany({ where: { conversationId: withPeer.conversationId } });
    await db.conversationMember.updateMany({
      where: { conversationId: withPeer.conversationId },
      data: { readThroughSequence: 0, unreadFromSequence: null },
    });
    const withSelf = await directConversation("e2e-activity-inbox:self-dm", DEV_BROWSER_USER.id);
    await post(
      withSelf.conversationId,
      "e2e-activity-inbox:dm-note",
      withSelf.members[0]!.id,
      "E2E activity note to self",
    );
    const helloId = await post(
      withPeer.conversationId,
      "e2e-activity-inbox:dm-hello",
      withPeer.members.find((member) => member.userId === peer.id)!.id,
      "E2E activity DM hello",
    );
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "wait",
      "--fn",
      `${card("E2E activity DM hello")} !== null && ${card("E2E activity note to self")} !== null && ${hydrated}`,
    );
    // The member's DM goes by their name and face, unread; the viewer's own by theirs, "(you)".
    const dm = await evaluate<{ text: string; avatar: string | null }>(
      card("E2E activity DM hello"),
    );
    expect(dm.text).toContain("@Activity DM Peer");
    expect(dm.text).toContain("Activity DM Peer: E2E activity DM hello");
    expect(dm.text).toContain("1 new");
    expect(dm.avatar).toBe("A");
    const self = await evaluate<{ text: string; avatar: string | null }>(
      card("E2E activity note to self"),
    );
    expect(self.text).toContain(`@${viewerName} (you)`);
    expect(self.text).not.toMatch(/\d+ new/);
    expect(self.avatar).not.toBeNull();
    await browser("screenshot", join(artifacts, "member-dm.png"));

    // Opening the card lands in the DM at the unread message and reads it.
    await browser("find", "text", "E2E activity DM hello", "click");
    await browser(
      "wait",
      "--fn",
      `location.pathname === ${JSON.stringify(`${workspacePath}/dm/${withPeer.conversationId}`)}`,
    );
    await browser("wait", "--fn", `document.getElementById("message-${helloId}") !== null`);
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${card("E2E activity DM hello")} !== null && ${hydrated}`);
    expect((await evaluate<{ text: string }>(card("E2E activity DM hello"))).text).not.toContain(
      "1 new",
    );
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
