import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The search page with nothing typed: the searches that led somewhere (Search history) and the
 * channels and Agents opened from search (Frequently used), both kept in this browser only.
 * Opening a message result records its query and its conversation; opening a match records the
 * typed text and the match. A repeated search moves to the front, whatever its case. A history
 * entry searches again; one can be removed, or all cleared. A frequently used card opens its
 * place.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Seeds are deterministic
 * and reset on every run. Screenshots are written under `.amp/e2e/search-home/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-home");
/** A Frequently used card: an entity link inside that section. */
const FREQUENT = '[aria-labelledby="search-frequent-heading"] [data-search-entity]';

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the empty search page offers recent searches and frequently used places", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-home-${process.pid}`;
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
  const history = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll("[data-search-history]")].map((tag) => tag.dataset.searchHistory)`,
    );
  const frequent = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(FREQUENT)})].map((card) => card.dataset.searchEntity)`,
    );
  async function openHome() {
    await browser("open", `${origin}/en/search`);
    await waitFor(`document.activeElement?.type === "search"`);
  }
  async function searchFor(query: string) {
    await browser("open", `${origin}/en/search?q=${encodeURIComponent(query)}`);
  }

  const channelA = seededUuid("e2e-search-home:channel-a");
  const channelB = seededUuid("e2e-search-home:channel-b");
  const phrase = "灯塔样本";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: { in: [channelA, channelB] } } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: { in: ["e2e-home-a", "e2e-home-b"] } },
    });
    await db.conversation.createMany({
      data: [
        { id: channelA, workspaceId, channelName: "e2e-home-a", description: "" },
        { id: channelB, workspaceId, channelName: "e2e-home-b", description: "" },
      ],
    });
    const author = await db.conversationMember.create({
      data: { conversationId: channelA, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const message = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: author.id,
        body: `${phrase} lives here`,
        sequence: 1,
      },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // A fresh browser has neither history nor frequently used places.
    await openHome();
    await browser("eval", "localStorage.clear()");
    await openHome();
    expect(await history()).toEqual([]);
    expect(await frequent()).toEqual([]);

    // Opening a message result records its query and its channel.
    await searchFor(phrase);
    await waitFor(`document.querySelector('[data-search-message-id="${message.id}"]') !== null`);
    await browser("dblclick", `[data-search-message-id="${message.id}"]`);
    await waitFor(`location.pathname === "/en/messages/channels/${channelA}"`);

    // Opening a match records the typed text and the match; the same search in another case
    // replaces the older entry instead of adding one.
    for (const query of ["E2E-HOME-B", "e2e-home-b"]) {
      await searchFor(query);
      await waitFor(
        `document.querySelector('[data-search-entity="channel:${channelB}"]') !== null`,
      );
      await browser("dblclick", `[data-search-entity="channel:${channelB}"]`);
      await waitFor(`location.pathname === "/en/messages/channels/${channelB}"`);
    }

    // The empty page lists both, newest first; the channel opened twice ranks first. A reload
    // keeps them: they live in this browser.
    await openHome();
    await waitFor(`document.querySelectorAll("[data-search-history]").length === 2`);
    expect(await history()).toEqual(["e2e-home-b", phrase]);
    expect(await frequent()).toEqual([`channel:${channelB}`, `channel:${channelA}`]);
    await browser("reload");
    await waitFor(`document.querySelectorAll("[data-search-history]").length === 2`);
    await browser("screenshot", join(artifacts, "home.png"));

    // A history entry searches again.
    await browser("click", `[data-search-history="${phrase}"]`);
    await waitFor(`new URLSearchParams(location.search).get("q") === "${phrase}"`);
    await waitFor(`document.querySelector('[data-search-message-id="${message.id}"]') !== null`);

    // A frequently used card opens its place.
    await openHome();
    await waitFor(
      `document.querySelector('${FREQUENT}[data-search-entity="channel:${channelA}"]') !== null`,
    );
    await browser("dblclick", `${FREQUENT}[data-search-entity="channel:${channelA}"]`);
    await waitFor(`location.pathname === "/en/messages/channels/${channelA}"`);

    // One entry can be removed, then the rest cleared; the frequently used places stay.
    await openHome();
    await waitFor(`document.querySelectorAll("[data-search-history]").length === 2`);
    await browser("click", `[aria-label="Remove “e2e-home-b” from search history"]`);
    await waitFor(`document.querySelectorAll("[data-search-history]").length === 1`);
    await browser(
      "eval",
      `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Clear").click()`,
    );
    await waitFor(`document.querySelectorAll("[data-search-history]").length === 0`);
    expect((await frequent()).length).toBe(2);
    await browser("reload");
    await waitFor(`document.querySelectorAll('${FREQUENT}').length === 2`);
    expect(await history()).toEqual([]);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA, channelB] } } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 240_000);

test("frequently used shows ten usable places and keeps opens from a clock slightly ahead", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-frequent-${process.pid}`;
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

  const ids = Array.from({ length: 11 }, (_, index) => seededUuid(`e2e-search-frequent:${index}`));
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: { in: ids } } });
    await db.conversation.createMany({
      data: ids.map((id, index) => ({
        id,
        workspaceId,
        channelName: `e2e-frequent-${index}`,
        description: "",
        // The most opened channel has since been archived.
        archivedAt: index === 0 ? new Date() : null,
      })),
    });
    // Channel 0 (archived) was opened most; channels 1–10 once each, newest first. Channel 1's
    // open is stamped two minutes ahead, as a clock that later stepped back would leave it.
    const now = Date.now();
    const usage = Object.fromEntries(
      ids.map((id, index) => [
        `channel:${id}`,
        index === 0
          ? [now - 1000, now - 2000, now - 3000]
          : [index === 1 ? now + 120_000 : now - index * 60_000],
      ]),
    );
    const usageKey = `coforge:search-usage:${workspaceId}:${DEV_BROWSER_USER.id}`;

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/search`);
    await browser(
      "eval",
      `localStorage.clear(); localStorage.setItem(${JSON.stringify(usageKey)}, ${JSON.stringify(JSON.stringify(usage))})`,
    );
    await browser("open", `${origin}/en/search`);
    // The archived channel is left out and the next place fills its slot: ten cards, 1–10.
    await waitFor(`document.querySelectorAll(${JSON.stringify(FREQUENT)}).length === 10`);
    const cards = await evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(FREQUENT)})].map((card) => card.dataset.searchEntity)`,
    );
    expect(cards).toEqual(ids.slice(1).map((id) => `channel:${id}`));

    // Opening another place keeps the open stamped slightly ahead.
    await browser("dblclick", `${FREQUENT}[data-search-entity="channel:${ids[5]}"]`);
    await waitFor(`location.pathname === "/en/messages/channels/${ids[5]}"`);
    const stored = await evaluate<Record<string, number[]>>(
      `JSON.parse(localStorage.getItem(${JSON.stringify(usageKey)}))`,
    );
    expect(stored[`channel:${ids[1]}`]).toEqual([now + 120_000]);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
