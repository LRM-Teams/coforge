import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Reaching search: Cmd/Ctrl+K from any page reopens the last search (and on the search page puts
 * the caret back in the box, text selected), the rail's Search starts fresh, and a channel's
 * "Search this channel" opens search limited to that channel without searching until something
 * is typed.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser` (Chromium on macOS, so the
 * shortcut is Meta+K). Seeds are deterministic and reset on every run. Screenshots are written
 * under `.amp/e2e/search-shortcut/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-shortcut");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the shortcut reopens the last search and a channel searches itself", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-shortcut-${process.pid}`;
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
            `location.pathname + location.search + " | " + document.querySelector("main")?.innerText`,
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
  const box = `document.querySelector('input[type="search"]')`;

  const channelA = seededUuid("e2e-search-shortcut:channel-a");
  const channelB = seededUuid("e2e-search-shortcut:channel-b");
  const phrase = "快捷样本";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: { in: [channelA, channelB] } } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: { in: ["e2e-shortcut-a", "e2e-shortcut-b"] } },
    });
    await db.conversation.createMany({
      data: [
        { id: channelA, workspaceId, channelName: "e2e-shortcut-a", description: "" },
        { id: channelB, workspaceId, channelName: "e2e-shortcut-b", description: "" },
      ],
    });
    const memberA = await db.conversationMember.create({
      data: { conversationId: channelA, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const memberB = await db.conversationMember.create({
      data: { conversationId: channelB, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const inA = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: memberA.id,
        body: `${phrase} in a`,
        sequence: 1,
      },
    });
    await db.message.create({
      data: {
        conversationId: channelB,
        workspaceId,
        senderMemberId: memberB.id,
        body: `${phrase} in b`,
        sequence: 1,
      },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // A search with a filter becomes the last search.
    await browser("open", `${origin}/en/search`);
    await browser("eval", "localStorage.clear()");
    await browser("open", `${origin}/en/search?q=${encodeURIComponent(phrase)}&range=7d`);
    await waitFor(`document.querySelectorAll("main ol li").length === 2`);
    // The box shows the shortcut.
    expect(await evaluate<string>(`document.querySelector("main").innerText`)).toContain("⌘K");

    // From another page, the shortcut reopens it.
    await browser("open", `${origin}/en/messages/channels/${channelA}`);
    await waitFor(
      `[...document.querySelectorAll("h1")].some((h) => h.textContent === "#e2e-shortcut-a")`,
    );
    await browser("press", "Meta+k");
    await waitFor(`location.pathname === "/en/search"`);
    await waitFor(`${param("q")} === ${JSON.stringify(phrase)} && ${param("range")} === "7d"`);
    await waitFor(`${box}.value === ${JSON.stringify(phrase)}`);
    // The reopened text is selected, ready to be typed over.
    await waitFor(
      `document.activeElement === ${box} && ${box}.selectionStart === 0 && ${box}.selectionEnd === ${phrase.length}`,
    );

    // On the search page it puts the caret back in the box with the text selected.
    await browser("eval", `${box}.blur()`);
    await browser("press", "Meta+k");
    await waitFor(
      `document.activeElement === ${box} && ${box}.selectionStart === 0 && ${box}.selectionEnd === ${phrase.length}`,
    );

    // A stored last search with a value the page does not know keeps only what it knows.
    const workspaceKey = `coforge:search-last:${workspaceId}:${DEV_BROWSER_USER.id}`;
    await browser(
      "eval",
      `localStorage.setItem(${JSON.stringify(workspaceKey)}, JSON.stringify({ q: "kept", range: "forever", extra: "x" }))`,
    );
    await browser("open", `${origin}/en/messages/channels/${channelA}`);
    await waitFor(
      `[...document.querySelectorAll("h1")].some((h) => h.textContent === "#e2e-shortcut-a")`,
    );
    await browser("press", "Meta+k");
    await waitFor(`location.pathname === "/en/search" && ${param("q")} === "kept"`);
    expect(await evaluate<string>("location.search")).toBe("?q=kept");

    // The rail's Search starts fresh.
    await browser("click", 'aside a[href="/en/search"]');
    await waitFor(`location.search === "" && ${box}.value === ""`);

    // A channel's "Search this channel" limits search to it and waits for a query.
    await browser("open", `${origin}/en/messages/channels/${channelA}`);
    await waitFor(`document.querySelector('[aria-label="Search this channel"]') !== null`);
    await browser("click", '[aria-label="Search this channel"]');
    await waitFor(`location.pathname === "/en/search" && ${param("channelId")} === "${channelA}"`);
    await waitFor(
      `[...document.querySelectorAll('[aria-label="Search filters"] button')].some((button) => button.textContent.includes("#e2e-shortcut-a"))`,
    );
    expect(await evaluate<number>(`document.querySelectorAll("main ol li").length`)).toBe(0);
    await browser("screenshot", join(artifacts, "channel-deferred.png"));
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`document.querySelectorAll("main ol li").length === 1`);
    expect(
      await evaluate<string>(
        `document.querySelector("[data-search-message-id]").dataset.searchMessageId`,
      ),
    ).toBe(inA.id);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA, channelB] } } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
