import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Channels, Agents and Computers matching the query, closest match first, listed above the
 * messages. A leading `#`
 * keeps only channels and a leading `@` only Agents. A channel opens itself, the viewer's own
 * Agent opens its direct messages, and a Computer opens its page.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Seeds are deterministic
 * and reset on every run; the Computer is seed-dev's "Mac Studio". Screenshots are written under
 * `.amp/e2e/search-entities/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-entities");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the search page lists matching channels, Agents and Computers and opens them", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-entities-${process.pid}`;
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
  async function searchFor(query: string, expected: string[]) {
    await browser("open", `${origin}/en/search?q=${encodeURIComponent(query)}`);
    await waitFor(
      `JSON.stringify([...document.querySelectorAll("[data-search-entity]")].map((row) => row.dataset.searchEntity)) === ${JSON.stringify(JSON.stringify(expected))}`,
    );
  }

  const channelId = seededUuid("e2e-search-entities:channel");
  const agentId = seededUuid("e2e-search-entities:agent");
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: channelId } });
    await db.conversation.deleteMany({ where: { workspaceId, channelName: "e2e-lighthouse" } });
    await db.conversation.create({
      data: { id: channelId, workspaceId, channelName: "e2e-lighthouse", description: "Beacon" },
    });
    await db.agent.upsert({
      where: { id: agentId },
      update: { deletedAt: null, visibility: "public" },
      create: {
        id: agentId,
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        name: "e2e-lighthouse-bot",
        displayName: "Lighthouse Bot",
        runtimeConfig: {
          runtime: "claude-code",
          provider: { kind: "default" },
          model: "claude-opus-4-6",
          modelProvider: "",
          reasoning: "high",
        },
      },
    });
    const computer = await db.computer.findFirstOrThrow({
      where: { name: "mac-studio-01", workspaces: { some: { workspaceId } } },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // Closer matches first: "Lighthouse Bot" starts with the query, "#e2e-lighthouse" only
    // contains it. Each row names its kind.
    await searchFor("lighthouse", [`agent:${agentId}`, `channel:${channelId}`]);
    const rows = await evaluate<string[]>(
      `[...document.querySelectorAll("[data-search-entity]")].map((row) => row.textContent)`,
    );
    expect(rows[0]).toContain("Lighthouse Bot");
    expect(rows[0]).toContain("Agent");
    expect(rows[1]).toContain("#e2e-lighthouse");
    expect(rows[1]).toContain("Channel");
    await browser("screenshot", join(artifacts, "entities.png"));

    // `#` keeps channels only, `@` keeps Agents only.
    await searchFor("#lighthouse", [`channel:${channelId}`]);
    await searchFor("@lighthouse", [`agent:${agentId}`]);

    // A Computer matches by its name.
    await searchFor("mac studio", [`computer:${computer.id}`]);

    // Opening: a channel opens itself, the viewer's own Agent its direct messages, a Computer
    // its page.
    await searchFor("lighthouse", [`agent:${agentId}`, `channel:${channelId}`]);
    await browser("click", `[data-search-entity="channel:${channelId}"]`);
    await waitFor(`location.pathname === "/en/messages/channels/${channelId}"`);
    await browser("back");
    await waitFor(`document.querySelector('[data-search-entity="agent:${agentId}"]') !== null`);
    await browser("click", `[data-search-entity="agent:${agentId}"]`);
    await waitFor(`location.pathname === "/en/messages/${agentId}"`);
    await searchFor("mac studio", [`computer:${computer.id}`]);
    await browser("click", `[data-search-entity="computer:${computer.id}"]`);
    await waitFor(`location.pathname === "/en/computers/${computer.id}"`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
    await db.agent
      .update({ where: { id: agentId }, data: { deletedAt: new Date() } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
