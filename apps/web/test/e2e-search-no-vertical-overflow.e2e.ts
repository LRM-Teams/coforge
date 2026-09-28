import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The search page keeps its scrolling inside its own list: the document never grows past the
 * viewport, neither on the empty page with a long Frequently used list on a phone, nor on a
 * search whose matches include an Agent on a short window.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user in a
 * Workspace with at least four Agents and six channels, one Agent named Atlas (seed-dev).
 * Frequently used is browser-local, so the test writes it into this session's storage. Each
 * viewport is short enough that the list overflows its scroll box, which the test checks first.
 * Screenshots are written under `.amp/e2e/search-overflow/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-overflow");

test("search never scrolls the document, on its empty page or with results", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-overflow-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "30000" },
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
  /** The Agent rows' list overflows its own scroll box (so the check means something); the
   * document does not. */
  async function expectOnlyTheListScrolls() {
    const overflow = JSON.parse(
      await browser(
        "eval",
        `(() => {
          let list = document.querySelector('[data-search-entity^="agent:"]');
          while (list && getComputedStyle(list).overflowY !== "auto") list = list.parentElement;
          return {
            document: document.documentElement.scrollHeight - document.documentElement.clientHeight,
            list: list ? list.scrollHeight - list.clientHeight : -1,
          };
        })()`,
      ),
    ) as { document: number; list: number };
    expect(overflow.list).toBeGreaterThan(0);
    expect(overflow.document).toBeLessThanOrEqual(0);
  }

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const { workspaceId } = membership;
    const [channels, agents] = await Promise.all([
      db.conversation.findMany({
        where: { workspaceId, channelName: { not: null }, archivedAt: null },
        orderBy: { createdAt: "asc" },
        take: 6,
        select: { id: true },
      }),
      db.agent.findMany({
        // Agents the dev user can see: public ones and its own private ones.
        where: {
          workspaceId,
          deletedAt: null,
          OR: [{ visibility: "public" }, { ownerId: DEV_BROWSER_USER.id }],
        },
        orderBy: { createdAt: "asc" },
        take: 4,
        select: { id: true },
      }),
    ]);
    // Channels opened more often rank first, so the Agent cards (and their hidden status text)
    // are the bottom of the list.
    const now = Date.now();
    const usage = Object.fromEntries([
      ...channels.map(({ id }) => [`channel:${id}`, [now, now - 1_000, now - 2_000]]),
      ...agents.map(({ id }) => [`agent:${id}`, [now - 5_000]]),
    ]);
    const storageScope = `${workspaceId}:${DEV_BROWSER_USER.id}`;

    await browser("set", "viewport", "390", "700");
    await browser("open", `${origin}/en/search`);
    await browser(
      "eval",
      `localStorage.setItem(${JSON.stringify(`coforge:search-usage:${storageScope}`)}, ${JSON.stringify(JSON.stringify(usage))});
       localStorage.removeItem(${JSON.stringify(`coforge:search-last:${storageScope}`)});`,
    );
    await browser("open", `${origin}/en/search`);
    await browser(
      "wait",
      "--fn",
      `document.querySelectorAll('[aria-labelledby="search-frequent-heading"] [data-search-entity^="agent:"]').length === ${agents.length}`,
    );
    await expectOnlyTheListScrolls();
    await mkdir(artifacts, { recursive: true });
    await browser("screenshot", join(artifacts, "search-home-phone.png"));

    await browser("set", "viewport", "1280", "200");
    await browser("open", `${origin}/en/search?q=atlas`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[data-search-entity^="agent:"]') !== null`,
    );
    await expectOnlyTheListScrolls();
    await browser("screenshot", join(artifacts, "search-results-short.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
