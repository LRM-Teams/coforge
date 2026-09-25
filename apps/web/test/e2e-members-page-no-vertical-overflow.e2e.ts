import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Members keeps its scrolling inside the directory list: the document itself never grows past the
 * viewport, with or without an Agent's profile open beside the list. A card's visually hidden
 * labels ("Created by", "Created on") are absolutely positioned; with no positioned ancestor they
 * escaped the list's scroll box, stretched the document to the list's full height, and a scroll
 * that reached the document pushed the whole page up, leaving a blank band under the profile.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user in a
 * Workspace with at least four Agents (seed-dev). The viewport is short enough that the list
 * overflows its scroll box, which the test checks first. A screenshot is written under
 * `.amp/e2e/members-page-overflow/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/members-page-overflow");

test("Members never scrolls the document, with or without an Agent's profile open", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `members-page-overflow-${process.pid}`;
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
  const measure = async () =>
    JSON.parse(
      await browser(
        "eval",
        `(() => {
          const list = document.querySelector('[role="tabpanel"]');
          return {
            document: document.documentElement.scrollHeight - document.documentElement.clientHeight,
            list: list ? list.scrollHeight - list.clientHeight : -1,
          };
        })()`,
      ),
    ) as { document: number; list: number };
  const cards = `document.querySelectorAll('a[aria-label^="Open "][aria-label$="profile"]').length >= 4`;

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const agent = await db.agent.findFirstOrThrow({
      where: { workspaceId: membership.workspaceId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });

    await browser("set", "viewport", "1280", "480");
    await browser("open", `${origin}/en/agents?memberType=agent&owner=all`);
    await browser("wait", "--fn", cards);
    const directory = await measure();
    expect(directory.list).toBeGreaterThan(0);
    expect(directory.document).toBeLessThanOrEqual(0);

    await browser(
      "open",
      `${origin}/en/agents?memberType=agent&owner=all&profile=agent%3A${agent.id}&agentTab=profile`,
    );
    await browser("wait", "--fn", cards);
    await browser("wait", "--fn", `document.querySelector('#profile[data-panel]') !== null`);
    const split = await measure();
    expect(split.list).toBeGreaterThan(0);
    expect(split.document).toBeLessThanOrEqual(0);

    await mkdir(artifacts, { recursive: true });
    await browser("screenshot", join(artifacts, "members-with-profile.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
