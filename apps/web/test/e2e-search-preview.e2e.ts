import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Previewing a result beside the list. On a wide screen a single click shows the result's
 * conversation next to the results, positioned at the message and without a composer; the list
 * stays, marking the previewed row, and the URL keeps the preview. Another click switches it,
 * Esc closes it, and a double click (or "Open conversation") opens the conversation itself. A
 * match previews its channel. On a phone a click opens the conversation directly.
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
    });
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

    // A single click previews the result beside the list, at the message, with no composer.
    await browser("open", `${origin}/en/search?q=${encodeURIComponent(phrase)}`);
    await waitFor(`document.querySelector('${row(inA.id)}') !== null`);
    await browser("click", row(inA.id));
    await waitFor(
      `${param("open")} === "channel:${channelA}" && ${param("msg")} === "${inA.id}" && location.pathname === "/en/search"`,
    );
    await waitFor(`document.querySelector('${PREVIEW} li[data-message-id="${inA.id}"]') !== null`);
    const preview = await evaluate<{ composer: boolean; listed: boolean; current: string | null }>(
      `({
        composer: document.querySelector('${PREVIEW} textarea') !== null,
        listed: document.querySelector('${row(inB.id)}') !== null,
        current: document.querySelector('${row(inA.id)}').getAttribute("aria-current"),
      })`,
    );
    expect(preview).toEqual({ composer: false, listed: true, current: "true" });
    await browser("screenshot", join(artifacts, "preview.png"));

    // Another result switches the preview; a reload keeps it.
    await browser("click", row(inB.id));
    await waitFor(`${param("open")} === "channel:${channelB}"`);
    await waitFor(`document.querySelector('${PREVIEW} li[data-message-id="${inB.id}"]') !== null`);
    await browser("reload");
    await waitFor(`document.querySelector('${PREVIEW} li[data-message-id="${inB.id}"]') !== null`);

    // Esc closes the preview and keeps the search.
    await browser("press", "Escape");
    await waitFor(`${param("open")} === "" && document.querySelector('${PREVIEW}') === null`);
    expect(await evaluate<string>(param("q"))).toBe(phrase);

    // "Open conversation" in the preview, and a double click on a result, open it for real.
    await browser("click", row(inA.id));
    await waitFor(`document.querySelector('${PREVIEW}') !== null`);
    await browser("click", `${PREVIEW} [aria-label="Open conversation"]`);
    await waitFor(`location.pathname === "/en/messages/channels/${channelA}"`);
    await browser("back");
    await waitFor(`document.querySelector('${row(inB.id)}') !== null`);
    const usageKey = `coforge:search-usage:${workspaceId}:${DEV_BROWSER_USER.id}`;
    const opensOfB = () =>
      evaluate<number>(
        `(JSON.parse(localStorage.getItem(${JSON.stringify(usageKey)}) ?? "{}")["channel:${channelB}"] ?? []).length`,
      );
    const opensBefore = await opensOfB();
    await browser("dblclick", row(inB.id));
    await waitFor(`location.pathname === "/en/messages/channels/${channelB}"`);
    // A double click is one open, not two.
    expect(await opensOfB()).toBe(opensBefore + 1);

    // A matching channel previews too, at its newest messages.
    await browser("open", `${origin}/en/search?q=e2e-preview-a`);
    await waitFor(`document.querySelector('[data-search-entity="channel:${channelA}"]') !== null`);
    await browser("click", `[data-search-entity="channel:${channelA}"]`);
    await waitFor(`${param("open")} === "channel:${channelA}" && ${param("msg")} === ""`);
    await waitFor(`document.querySelector('${PREVIEW}')?.textContent.includes("after 80")`);

    // Esc with no preview leaves search for the page it was opened from, even after a filter
    // change added a step of its own.
    await browser("open", `${origin}/en/messages/channels/${channelB}`);
    await waitFor(
      `[...document.querySelectorAll("h1")].some((h) => h.textContent === "#e2e-preview-b")`,
    );
    await browser("click", 'aside a[href="/en/search"]');
    await waitFor(`location.pathname === "/en/search"`);
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
    await waitFor(`location.pathname === "/en/messages/channels/${channelB}"`);

    // Opening a result and coming Back keeps where search was opened from: Esc closes the
    // preview, then returns to that page, not to the conversation just visited.
    await browser("click", 'aside a[href="/en/search"]');
    await waitFor(`location.pathname === "/en/search"`);
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`document.querySelector('${row(inA.id)}') !== null`);
    await browser("click", row(inA.id));
    await waitFor(`document.querySelector('${PREVIEW}') !== null`);
    await browser("click", `${PREVIEW} [aria-label="Open conversation"]`);
    await waitFor(`location.pathname === "/en/messages/channels/${channelA}"`);
    await browser("back");
    await waitFor(
      `location.pathname === "/en/search" && document.querySelector('${PREVIEW}') !== null`,
    );
    await browser("eval", `document.activeElement?.blur()`);
    await browser("press", "Escape");
    await waitFor(`document.querySelector('${PREVIEW}') === null`);
    await browser("press", "Escape");
    await waitFor(`location.pathname === "/en/messages/channels/${channelB}"`);

    // On a phone there is no room beside the list: a click opens the conversation.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/search?q=${encodeURIComponent(phrase)}`);
    await waitFor(`document.querySelector('${row(inA.id)}') !== null`);
    await browser("click", row(inA.id));
    await waitFor(`location.pathname === "/en/messages/channels/${channelA}"`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA, channelB] } } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 480_000);
