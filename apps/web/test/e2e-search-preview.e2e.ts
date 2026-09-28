import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Previewing a result beside the list. On a wide screen a single click shows the result's
 * conversation next to the results exactly as Chat opens it: positioned at the message, its header
 * (with the Chat / Tasks / Files tabs) lined up with the search header, its composer, and read as
 * Chat reads it. A reply sent there lands in the conversation; a thread reply opens its thread.
 * The list stays, marking the previewed row, and the URL keeps the preview. Another click switches
 * it, Esc outside the conversation closes it, and a double click opens the conversation itself (a
 * thread reply with its thread open). A match previews its channel. On a phone a click opens the
 * conversation directly.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Seeds are deterministic
 * and reset on every run. Screenshots are written under `.amp/e2e/search-preview/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-preview");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("a result previews beside the list and opens on a double click", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-preview-${process.pid}`;
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
  /** Waits for a page condition, failing with the condition and the page text after 15 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser(
            "eval",
            `location.pathname + location.search + " | " + document.querySelector("main")?.innerText.slice(0, 600)`,
          )
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 15_000);
      }),
    ]);
  };
  const param = (name: string) =>
    `(new URLSearchParams(location.search).get(${JSON.stringify(name)}) ?? "")`;
  const PREVIEW = '[aria-label="Search preview"]';
  const row = (id: string) => `[data-search-message-id="${id}"]`;

  const channelA = seededUuid("e2e-search-preview:channel-a");
  const channelB = seededUuid("e2e-search-preview:channel-b");
  const phrase = "预览样本";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: { in: [channelA, channelB] } } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: { in: ["e2e-preview-a", "e2e-preview-b"] } },
    });
    await db.conversation.createMany({
      data: [
        { id: channelA, workspaceId, channelName: "e2e-preview-a", description: "" },
        { id: channelB, workspaceId, channelName: "e2e-preview-b", description: "" },
      ],
    });
    const [memberA, memberB] = await Promise.all(
      [channelA, channelB].map((conversationId) =>
        db.conversationMember.create({
          data: { conversationId, workspaceId, userId: DEV_BROWSER_USER.id },
        }),
      ),
    );
    // Channel A: the match sits well above the newest page, so the preview has to jump to it.
    const bodies = [
      ...Array.from({ length: 30 }, (_, index) => `before ${index + 1}`),
      `${phrase} in a`,
      ...Array.from({ length: 80 }, (_, index) => `after ${index + 1}`),
    ];
    const start = Date.now() - bodies.length * 60_000;
    await db.message.createMany({
      data: bodies.map((body, index) => ({
        conversationId: channelA,
        workspaceId,
        senderMemberId: memberA!.id,
        body,
        sequence: index + 1,
        createdAt: new Date(start + index * 60_000),
      })),
    });
    const inA = await db.message.findFirstOrThrow({
      where: { conversationId: channelA, body: `${phrase} in a` },
    });
    // A reply in the match's thread matches too, with enough replies after it that landing on it
    // is not the pane's default.
    const inThread = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: memberA!.id,
        body: `${phrase} in a thread`,
        threadRootId: inA.id,
        sequence: bodies.length + 1,
      },
    });
    await db.message.createMany({
      data: Array.from({ length: 40 }, (_, index) => ({
        conversationId: channelA,
        workspaceId,
        senderMemberId: memberA!.id,
        body: `thread reply ${index + 1}`,
        threadRootId: inA.id,
        sequence: bodies.length + 2 + index,
      })),
    });
    const inB = await db.message.create({
      data: {
        conversationId: channelB,
        workspaceId,
        senderMemberId: memberB!.id,
        body: `${phrase} in b`,
        sequence: 1,
      },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // A single click previews the result beside the list, at the message, with its composer.
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    await waitFor(`document.querySelector('${row(inA.id)}') !== null`);
    await browser("click", row(inA.id));
    await waitFor(
      `${param("open")} === "channel:${channelA}" && ${param("msg")} === "${inA.id}" && location.pathname === "${workspacePath}/search"`,
    );
    await waitFor(`document.querySelector('${PREVIEW} li[data-message-id="${inA.id}"]') !== null`);
    await waitFor(`document.querySelector('${PREVIEW} textarea:not([disabled])') !== null`);
    // It opens at the result, on screen, as Chat does from a link to a message.
    await waitFor(`(() => {
      const rect = document.querySelector('${PREVIEW} li[data-message-id="${inA.id}"]').getBoundingClientRect();
      return rect.top >= 48 && rect.bottom <= innerHeight;
    })()`);
    const preview = await evaluate<{
      listed: boolean;
      current: string | null;
      headerBottoms: number[];
    }>(
      `({
        listed: document.querySelector('${row(inB.id)}') !== null,
        current: document.querySelector('${row(inA.id)}').getAttribute("aria-current"),
        // The search header and the conversation's header end on one line.
        headerBottoms: [
          document.querySelector("main header"),
          document.querySelector('${PREVIEW} header'),
        ].map((header) => Math.round(header.getBoundingClientRect().bottom)),
      })`,
    );
    expect({ listed: preview.listed, current: preview.current }).toEqual({
      listed: true,
      current: "true",
    });
    expect(preview.headerBottoms[1]).toBe(preview.headerBottoms[0]!);
    await browser("screenshot", join(artifacts, "preview.png"));

    // The preview carries the conversation's tabs, and reads the channel as Chat does.
    const tabs = await evaluate<string[]>(
      `[...document.querySelectorAll('${PREVIEW} [role="tab"]')].map((tab) => tab.textContent.trim())`,
    );
    expect(tabs).toEqual(["Chat", "Tasks", "Files"]);
    const readUpTo = async () =>
      (await db.conversationMember.findFirstOrThrow({ where: { id: memberA!.id } }))
        .readThroughSequence;
    for (let attempt = 0; (await readUpTo()) === 0 && attempt < 50; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readUpTo()).toBeGreaterThan(0);
    await browser(
      "eval",
      `[...document.querySelectorAll('${PREVIEW} [role="tab"]')].find((tab) => tab.textContent.trim() === "Tasks").click()`,
    );
    await waitFor(
      `${param("view")} === "tasks" && location.pathname === "${workspacePath}/search" && [...document.querySelectorAll('${PREVIEW} button')].some((button) => button.textContent.trim() === "Create task")`,
    );
    await browser("screenshot", join(artifacts, "tasks.png"));
    await browser(
      "eval",
      `[...document.querySelectorAll('${PREVIEW} [role="tab"]')].find((tab) => tab.textContent.trim() === "Chat").click()`,
    );
    await waitFor(
      `${param("view")} === "chat" && document.querySelector('${PREVIEW} textarea') !== null`,
    );

    // A reply sent from the preview lands in the conversation, and the preview stays.
    const reply = `reply from search ${Date.now()}`;
    await browser("fill", `${PREVIEW} textarea`, reply);
    await browser("press", "Enter");
    await waitFor(
      `[...document.querySelectorAll('${PREVIEW} li[data-message-id]')].some((item) => item.textContent.includes(${JSON.stringify(reply)}))`,
    );
    const saved = await db.message.findFirst({ where: { conversationId: channelA, body: reply } });
    expect(saved).not.toBeNull();
    expect(await evaluate<string>(`location.pathname`)).toBe(`${workspacePath}/search`);
    await browser("screenshot", join(artifacts, "replied.png"));

    // Esc in the conversation (its composer) belongs to the conversation: the preview stays.
    await browser("focus", `${PREVIEW} textarea`);
    await browser("press", "Escape");
    expect(await evaluate<string>(param("open"))).toBe(`channel:${channelA}`);

    // A thread opens inside the preview (here on the reply just sent), kept in the search URL like
    // the conversation's own page.
    await browser(
      "eval",
      `document.querySelector('${PREVIEW} li[data-message-id="${saved!.id}"] [aria-label^="Reply in thread"]').click()`,
    );
    await waitFor(
      `${param("threadRootId")} === "${saved!.id}" && location.pathname === "${workspacePath}/search"`,
    );
    await waitFor(
      `[...document.querySelectorAll('${PREVIEW} section[aria-label="Thread"]')].some((pane) => !pane.hidden)`,
    );
    await browser("screenshot", join(artifacts, "thread.png"));

    // Another result switches the preview, and the thread goes with the old one; a reload keeps
    // the preview.
    await browser("click", row(inB.id));
    await waitFor(`${param("open")} === "channel:${channelB}" && ${param("threadRootId")} === ""`);
    await waitFor(`document.querySelector('${PREVIEW} li[data-message-id="${inB.id}"]') !== null`);
    await browser("reload");
    await waitFor(`document.querySelector('${PREVIEW} li[data-message-id="${inB.id}"]') !== null`);

    // Esc from the search side closes the preview and keeps the search. (The preview's composer
    // takes the caret when it opens, as a conversation does.)
    await browser("focus", 'input[type="search"]');
    await browser("press", "Escape");
    await waitFor(`${param("open")} === "" && document.querySelector('${PREVIEW}') === null`);
    expect(await evaluate<string>(param("q"))).toBe(phrase);

    // A thread reply previews with its thread open at that reply, and a double click opens it in
    // Chat the same way, as Activity opens a thread.
    const replyOnScreen = `(() => {
      const pane = [...document.querySelectorAll('section[aria-label="Thread"]')].find((section) => !section.hidden);
      const reply = pane?.querySelector('li[data-message-id="${inThread.id}"]');
      if (!reply) return false;
      const rect = reply.getBoundingClientRect();
      return rect.top >= 48 && rect.bottom <= innerHeight;
    })()`;
    await browser("click", row(inThread.id));
    await waitFor(`${param("threadRootId")} === "${inA.id}"`);
    await waitFor(replyOnScreen);
    await browser("screenshot", join(artifacts, "thread-hit.png"));
    await browser("dblclick", row(inThread.id));
    await waitFor(
      `location.pathname === "${workspacePath}/channel/${channelA}" && ${param("threadRootId")} === "${inA.id}"`,
    );
    await waitFor(replyOnScreen);
    await browser("back");
    await waitFor(`document.querySelector('${row(inB.id)}') !== null`);

    // A double click on a result opens it for real, counted as one open.
    const usageKey = `coforge:search-usage:${workspaceId}:${DEV_BROWSER_USER.id}`;
    const opensOfB = () =>
      evaluate<number>(
        `(JSON.parse(localStorage.getItem(${JSON.stringify(usageKey)}) ?? "{}")["channel:${channelB}"] ?? []).length`,
      );
    // The preview and Chat share one Saved list: saved in the preview, Chat shows it saved at once,
    // and removing it there shows in the preview again.
    const saveButton = (scope: string, label: string) =>
      `document.querySelector('${scope} li[data-message-id="${inB.id}"] [aria-label="${label}"]')`;
    await browser("click", row(inB.id));
    await waitFor(`${saveButton(PREVIEW, "Save message")} !== null`);
    await browser("eval", `${saveButton(PREVIEW, "Save message")}.click()`);
    await waitFor(`${saveButton(PREVIEW, "Remove from Saved")} !== null`);
    const opensBefore = await opensOfB();
    await browser("dblclick", row(inB.id));
    await waitFor(`location.pathname === "${workspacePath}/channel/${channelB}"`);
    // A double click is one open, not two.
    expect(await opensOfB()).toBe(opensBefore + 1);
    await waitFor(`${saveButton("main", "Remove from Saved")} !== null`);
    await browser("eval", `${saveButton("main", "Remove from Saved")}.click()`);
    await waitFor(`${saveButton("main", "Save message")} !== null`);
    await browser("back");
    await waitFor(`${saveButton(PREVIEW, "Save message")} !== null`);

    // A message saved elsewhere meanwhile (another tab) shows saved when Chat is opened again: each
    // visit reads the Saved list afresh.
    await browser("click", `aside a[href="${workspacePath}/tasks"]`);
    await waitFor(`location.pathname === "${workspacePath}/tasks"`);
    await db.savedMessage.create({
      data: { messageId: inB.id, conversationId: channelB, workspaceId, memberId: memberB!.id },
    });
    await browser("click", `aside a[href="${workspacePath}"]`);
    await waitFor(`location.pathname.startsWith("${workspacePath}")`);
    await browser(
      "eval",
      `document.querySelector('a[href="${workspacePath}/channel/${channelB}"]').click()`,
    );
    await waitFor(`location.pathname === "${workspacePath}/channel/${channelB}"`);
    await waitFor(`${saveButton("main", "Remove from Saved")} !== null`);
    await browser("eval", `${saveButton("main", "Remove from Saved")}.click()`);
    await waitFor(`${saveButton("main", "Save message")} !== null`);
    await browser("back");
    await browser("back");
    await browser("back");
    await waitFor(`location.pathname === "${workspacePath}/search"`);

    // A matching channel previews too, at its newest messages.
    await browser("open", `${origin}${workspacePath}/search?q=e2e-preview-a`);
    await waitFor(`document.querySelector('[data-search-entity="channel:${channelA}"]') !== null`);
    await browser("click", `[data-search-entity="channel:${channelA}"]`);
    await waitFor(`${param("open")} === "channel:${channelA}" && ${param("msg")} === ""`);
    await waitFor(`document.querySelector('${PREVIEW}')?.textContent.includes("after 80")`);

    // Esc with no preview leaves search for the page it was opened from, even after a filter
    // change added a step of its own.
    await browser("open", `${origin}${workspacePath}/channel/${channelB}`);
    await waitFor(
      `[...document.querySelectorAll("h1")].some((h) => h.textContent === "#e2e-preview-b")`,
    );
    await browser("click", `aside a[href="${workspacePath}/search"]`);
    await waitFor(`location.pathname === "${workspacePath}/search"`);
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`document.querySelector('${row(inA.id)}') !== null`);
    // A filter change pushes a history step of its own.
    await browser(
      "eval",
      `[...document.querySelectorAll('[aria-label="Search filters"] button')].find((button) => button.textContent.trim().startsWith("Time")).click()`,
    );
    await waitFor(
      `[...document.querySelectorAll('[role="menuitemradio"]')].some((item) => item.textContent.includes("Last 7 days"))`,
    );
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.includes("Last 7 days")).click()`,
    );
    await waitFor(`${param("range")} === "7d"`);
    await browser("eval", `document.activeElement?.blur()`);
    await browser("press", "Escape");
    await waitFor(`location.pathname === "${workspacePath}/channel/${channelB}"`);

    // Opening a result and coming Back keeps where search was opened from: Esc closes the
    // preview, then returns to that page, not to the conversation just visited.
    await browser("click", `aside a[href="${workspacePath}/search"]`);
    await waitFor(`location.pathname === "${workspacePath}/search"`);
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`document.querySelector('${row(inA.id)}') !== null`);
    await browser("click", row(inA.id));
    await waitFor(`document.querySelector('${PREVIEW}') !== null`);
    await browser("dblclick", row(inA.id));
    await waitFor(`location.pathname === "${workspacePath}/channel/${channelA}"`);
    await browser("back");
    await waitFor(
      `location.pathname === "${workspacePath}/search" && document.querySelector('${PREVIEW}') !== null`,
    );
    await browser("eval", `document.activeElement?.blur()`);
    await browser("press", "Escape");
    await waitFor(`document.querySelector('${PREVIEW}') === null`);
    await browser("press", "Escape");
    await waitFor(`location.pathname === "${workspacePath}/channel/${channelB}"`);

    // Chat opened at a message lands on it even with unread messages above it (the viewer's default
    // "first unread" open mode does not take over a jump).
    await db.conversationMember.update({
      where: { id: memberA!.id },
      data: { readThroughSequence: 0 },
    });
    await browser("open", `${origin}${workspacePath}/channel/${channelA}?message=${inA.id}`);
    await waitFor(`(() => {
      const row = document.querySelector('main li[data-message-id="${inA.id}"]');
      if (!row) return false;
      const rect = row.getBoundingClientRect();
      return rect.top >= 48 && rect.bottom <= innerHeight;
    })()`);

    // On a phone there is no room beside the list: a click opens the conversation.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    await waitFor(`document.querySelector('${row(inA.id)}') !== null`);
    await browser("click", row(inA.id));
    await waitFor(`location.pathname === "${workspacePath}/channel/${channelA}"`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA, channelB] } } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 480_000);
