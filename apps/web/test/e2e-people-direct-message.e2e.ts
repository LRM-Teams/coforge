import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { peopleDirectKey } from "#src/features/conversations/direct-key";

/**
 * A direct message between Workspace members. A collaborator's card on the Members page opens the
 * viewer's DM with them: its page names the member in the header with the Chat / Tasks / Files
 * tabs, takes a message, shows it again after a reload, and is read. The viewer's own card opens their DM
 * with themself, marked "(you)". A search result posted there names the member and previews that
 * DM beside the results.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It seeds one member and deletes what it created. Screenshots are
 * written under `.amp/e2e/people-direct-message/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/people-direct-message");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("members open a direct message with each other, and with themselves", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `people-dm-${process.pid}`;
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
  /** The "Private chat" button on the Members page card of `name`. */
  const cardChat = (name: string) =>
    `[...([...document.querySelectorAll('[role="row"]')].find((card) => card.querySelector("h2")?.textContent.startsWith(${JSON.stringify(name)}))?.querySelectorAll("button") ?? [])].find((button) => button.textContent.trim() === "Private chat")`;
  /** Presses it once the page has hydrated (the server-rendered button does nothing before). */
  const pressCardChat = async (name: string) => {
    await waitFor(
      `Object.keys(${cardChat(name)} ?? {}).some((key) => key.startsWith("__reactProps"))`,
    );
    await browser("eval", `${cardChat(name)}.click()`);
  };
  /** The conversation's header: the one carrying the Chat / Tasks / Files tabs. */
  const conversationHeader = `[...document.querySelectorAll("main header")].find((header) => header.querySelector('[role="tab"]'))`;
  const headerName = `${conversationHeader}?.querySelector("h1")?.textContent.trim()`;
  const PREVIEW = '[aria-label="Search preview"]';

  const peerId = seededUuid("e2e-people-direct-message:peer");
  const peerName = "People Peer";
  const phrase = `成员私聊样本 ${Date.now()}`;
  const dmKey = peopleDirectKey(DEV_BROWSER_USER.id, peerId);
  const selfKey = peopleDirectKey(DEV_BROWSER_USER.id, DEV_BROWSER_USER.id);
  let workspaceId: string | undefined;
  let selfDmExisted = true;
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    workspaceId = membership.workspaceId;
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    await db.conversation.deleteMany({ where: { workspaceId, directKey: dmKey } });
    selfDmExisted =
      (await db.conversation.count({ where: { workspaceId, directKey: selfKey } })) > 0;
    await db.user.upsert({
      where: { id: peerId },
      create: { id: peerId, username: "e2e-people-dm-peer", displayName: peerName },
      update: { displayName: peerName },
    });
    await db.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: peerId } },
      create: { workspaceId, userId: peerId, role: "member" },
      update: {},
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // A collaborator's card opens the viewer's DM with them, by its conversation id.
    await browser("open", `${origin}${workspacePath}/members?memberType=human`);
    await waitFor(
      `[...document.querySelectorAll('[role="row"] h2')].some((name) => name.textContent.startsWith(${JSON.stringify(peerName)}))`,
    );
    await browser("screenshot", join(artifacts, "members.png"));
    await pressCardChat(peerName);
    await waitFor(`location.pathname.startsWith("${workspacePath}/dm/")`);
    const dm = await db.conversation.findFirstOrThrow({ where: { workspaceId, directKey: dmKey } });
    expect(await evaluate<string>("location.pathname")).toBe(`${workspacePath}/dm/${dm.id}`);

    // Its header names the member and carries the conversation tabs.
    await waitFor(`${headerName}?.startsWith(${JSON.stringify(peerName)})`);
    const tabs = await evaluate<string[]>(
      `[...document.querySelectorAll('main [role="tab"]')].map((tab) => tab.textContent.trim())`,
    );
    expect(tabs).toEqual(["Chat", "Tasks", "Files"]);

    // A message sent there is kept, and a reload shows it again.
    await waitFor(`document.querySelector('main textarea:not([disabled])') !== null`);
    await browser("fill", "main textarea", phrase);
    await browser("press", "Enter");
    const shown = `[...document.querySelectorAll('main li[data-message-id]')].some((item) => item.textContent.includes(${JSON.stringify(phrase)}))`;
    await waitFor(shown);
    const sent = await db.message.findFirstOrThrow({
      where: { conversationId: dm.id, body: phrase },
    });
    await browser("reload");
    await waitFor(shown);
    // Opening it reads it: the viewer's read cursor moves past the message.
    const readUpTo = async () =>
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: dm.id, userId: DEV_BROWSER_USER.id },
        })
      ).readThroughSequence;
    for (let attempt = 0; (await readUpTo()) < sent.sequence && attempt < 50; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readUpTo()).toBeGreaterThanOrEqual(sent.sequence);
    await browser("screenshot", join(artifacts, "people-dm.png"));

    // The viewer's own card opens their DM with themself, marked as them.
    await browser("open", `${origin}${workspacePath}/members?memberType=human`);
    await waitFor(
      `[...document.querySelectorAll('[role="row"] h2')].some((name) => name.textContent.startsWith("Dev User"))`,
    );
    await pressCardChat("Dev User");
    const selfDm = async () =>
      db.conversation.findFirst({ where: { workspaceId, directKey: selfKey } });
    await waitFor(`location.pathname.startsWith("${workspacePath}/dm/")`);
    await waitFor(`${headerName}?.startsWith("Dev User")`);
    const self = await selfDm();
    expect(await evaluate<string>("location.pathname")).toBe(`${workspacePath}/dm/${self!.id}`);
    expect(await evaluate<string>(`${conversationHeader}?.textContent`)).toContain("(you)");
    await browser("screenshot", join(artifacts, "self-dm.png"));

    // A search result from the DM names the member it is with and previews that DM.
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    const row = `[data-search-message-id="${sent.id}"]`;
    await waitFor(`document.querySelector('${row}') !== null`);
    expect(await evaluate<string>(`document.querySelector('${row}').textContent`)).toContain(
      `@${peerName}`,
    );
    await browser("click", row);
    await waitFor(`${param("open")} === "dm:${dm.id}" && ${param("msg")} === "${sent.id}"`);
    await waitFor(
      `document.querySelector('${PREVIEW} header h1')?.textContent.startsWith(${JSON.stringify(peerName)})`,
    );
    await waitFor(`document.querySelector('${PREVIEW} li[data-message-id="${sent.id}"]') !== null`);
    await browser("screenshot", join(artifacts, "search-preview.png"));
  } finally {
    await browser("close").catch(() => undefined);
    if (workspaceId) {
      await db.conversation
        .deleteMany({ where: { workspaceId, directKey: dmKey } })
        .catch(() => {});
      if (!selfDmExisted)
        await db.conversation
          .deleteMany({ where: { workspaceId, directKey: selfKey } })
          .catch(() => {});
      await db.workspaceMembership
        .deleteMany({ where: { workspaceId, userId: peerId } })
        .catch(() => {});
    }
    await db.user.deleteMany({ where: { id: peerId } }).catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
