import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";

/**
 * Joining a Workspace from its invite link. The link's page names the Workspace and who is in it;
 * a signed-in visitor who is not a member presses "Join <name>", lands in the Workspace, and is a
 * member of it and of its #general. A join that fails says why and what to do: a lost connection
 * offers "Try again" (the same button joins once the connection is back), an ended session offers
 * "Sign in again", and a link that does not work says so.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It seeds one Workspace (with its own owner) the dev user is not in,
 * and deletes what it created. Screenshots are written under `.amp/e2e/workspace-join-link/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/workspace-join-link");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("a signed-in visitor joins a Workspace from its invite link", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `join-link-${process.pid}`;
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

  const ownerId = seededUuid("e2e-workspace-join-link:owner");
  const slug = "e2e-join-link";
  const name = "Join Link Team";
  let workspaceId: string | undefined;
  try {
    // A leftover from an interrupted run starts over.
    await db.workspace.deleteMany({ where: { slug } });
    await db.user.upsert({
      where: { id: ownerId },
      create: { id: ownerId, username: "e2e-join-link-owner", displayName: "Join Link Owner" },
      update: {},
    });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug,
      name,
      userId: ownerId,
    });
    workspaceId = workspace.id;
    const link = await workspaceJoinLinks(db).create({
      workspaceId,
      actorUserId: ownerId,
      maxUses: null,
      expiresAt: null,
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // The link's page names the Workspace and who is in it, and offers to join.
    await browser("open", `${origin}/en/join/${link.token}`);
    const joinButton = `[...document.querySelectorAll("main button")].find((button) => button.textContent.trim() === ${JSON.stringify(`Join ${name}`)})`;
    const retryButton = `[...document.querySelectorAll("main button")].find((button) => button.textContent.trim() === "Try again")`;
    const buttonLabels = `[...document.querySelectorAll("main button")].map((button) => button.textContent.trim())`;
    await waitFor(`Object.keys(${joinButton} ?? {}).some((key) => key.startsWith("__reactProps"))`);
    expect(await evaluate<string>(`document.querySelector("main h1")?.textContent`)).toBe(
      `Join ${name}`,
    );
    expect(await evaluate<string>(`document.querySelector("main")?.innerText`)).toContain(
      "It has 1 member.",
    );
    await browser("screenshot", join(artifacts, "join-page.png"));

    // A session that ended after the page loaded comes back from the server as a redirect to
    // sign-in (the dev server has no real session to end). The page says so and offers to sign
    // in again instead of joining.
    const signInRedirect = `/login?returnTo=%2Fjoin%2F${link.token}`;
    await browser(
      "eval",
      `window.__fetch = window.fetch; window.fetch = (input, init) => String(input?.url ?? input).includes("/_serverFn/") && init?.method === "POST" ? Promise.resolve(new Response(JSON.stringify({ href: "${signInRedirect}", statusCode: 307, isSerializedRedirect: true }), { status: 200, headers: { "content-type": "application/json;charset=utf-8", location: "${signInRedirect}" } })) : window.__fetch(input, init)`,
    );
    await browser("eval", `${joinButton}.click()`);
    await waitFor(
      `document.querySelector("main [role=alert]")?.textContent === "Your session has expired. Sign in again to join."`,
    );
    expect(await evaluate<string[]>(buttonLabels)).toEqual([
      "Sign in again",
      "Use another account",
    ]);
    await browser("screenshot", join(artifacts, "join-session-ended.png"));

    // A lost connection says so, and the same button tries again once the connection is back.
    await browser("open", `${origin}/en/join/${link.token}`);
    await waitFor(`Object.keys(${joinButton} ?? {}).some((key) => key.startsWith("__reactProps"))`);
    await browser(
      "eval",
      `window.__fetch = window.fetch; window.fetch = (input, init) => String(input?.url ?? input).includes("/_serverFn/") && init?.method === "POST" ? Promise.reject(new TypeError("Failed to fetch")) : window.__fetch(input, init)`,
    );
    await browser("eval", `${joinButton}.click()`);
    await waitFor(
      `document.querySelector("main [role=alert]")?.textContent === "Couldn’t join. Check your connection and try again."`,
    );
    expect(await evaluate<string[]>(buttonLabels)).toEqual(["Try again", "Use another account"]);
    await browser("screenshot", join(artifacts, "join-connection-lost.png"));

    // Joining lands in the Workspace, as a member of it and of its #general.
    await browser("eval", `window.fetch = window.__fetch; ${retryButton}.click()`);
    await waitFor(`location.pathname.startsWith("/en/w/${slug}")`);
    const membership = await db.workspaceMembership.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } },
    });
    expect(membership.role).toBe("member");
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
    });
    expect(
      await db.conversationMember.count({
        where: { conversationId: general.id, userId: DEV_BROWSER_USER.id, leftAt: null },
      }),
    ).toBe(1);
    await browser("screenshot", join(artifacts, "joined.png"));

    // A link that does not work says so and offers the way out.
    await browser("open", `${origin}/en/join/not-an-invite-link`);
    await waitFor(
      `document.querySelector("main h1")?.textContent === "This invite link can’t be used"`,
    );
    expect(await evaluate<string>(`document.querySelector("main [role=alert]")?.textContent`)).toBe(
      "This invite link is invalid or has expired. Ask the person who invited you for a new link.",
    );
    await browser("screenshot", join(artifacts, "join-link-invalid.png"));
  } finally {
    await browser("close").catch(() => undefined);
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: ownerId } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
