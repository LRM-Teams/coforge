import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The browser's copy of the Query cache in a real browser (`src/features/cache-persistence/`):
 * Chat opens from it while the network reads are still outstanding, then the reads bring it up to
 * date; signing out removes it; another person on the browser starts from nothing.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace (seed-dev). The browser talks to a proxy in this test that forwards to
 * `COFORGE_E2E_WEB_URL` and can hold the Chat reads (the sidebar lists, the channel names and the
 * conversation) until the test lets them through; the proxy's origin is also a fresh IndexedDB,
 * so a run starts with nothing stored. It stands in for `/auth/logout`, which would leave for
 * Authing. Each run seeds a channel with messages and removes it afterwards. Screenshots are
 * written under `.amp/e2e/query-cache-persistence/`.
 */
const upstreamOrigin = Bun.env.COFORGE_E2E_WEB_URL;
if (!upstreamOrigin || !["localhost", "127.0.0.1"].includes(new URL(upstreamOrigin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/query-cache-persistence");

/** The reads Chat makes for what the browser keeps: the two sidebar lists' calls, the channel
 * names and the conversation. */
const CHAT_READS = [
  "listPublicChannels",
  "loadDirectConversationPreferences",
  "loadDirectConversationBadges",
  "listChannelNames",
  "loadPublicChannel",
] as const;

/** This build's Server Function ids, by export name. The id on the wire is the hash the build gave
 * the function - it does not encode the name, so it cannot be decoded back out of the URL. The
 * artifact the local Web is serving states the pairing, one line per function:
 * `NAME_createServerFn_handler = createServerRpc({ id: "<64 hex>" ...`. */
function serverFunctionIds(): Map<string, string> {
  const bundle = join(import.meta.dir, "../.output/server/index.mjs");
  let source: string;
  try {
    source = readFileSync(bundle, "utf8");
  } catch {
    throw new Error(
      `${bundle} is missing: build the Web package first (NODE_ENV=production bun run --cwd apps/web build)`,
    );
  }
  const byName = new Map<string, string>();
  const pattern =
    /([A-Za-z0-9_$]+)_createServerFn_handler\s*=\s*createServerRpc\(\{\s*id:\s*"([0-9a-f]{64})"/g;
  for (const [, name, id] of source.matchAll(pattern)) byName.set(name, id);
  const ids = new Map<string, string>();
  for (const name of CHAT_READS) {
    const id = byName.get(name);
    // Never skip silently: an e2e that means to hold Chat's reads must fail loudly if it cannot
    // recognise them in this build (docs/agents/testing.md).
    if (!id) throw new Error(`Server Function ${name} is not in ${bundle}`);
    ids.set(id, name);
  }
  return ids;
}
const chatReadIds = serverFunctionIds();

type ProxySocket = {
  path: string;
  protocol?: string;
  upstream?: WebSocket;
  pending: Array<string | Uint8Array<ArrayBuffer>>;
};

/** Forwards to the local Web service, holding the Chat reads while `hold()` is on. */
function gatedProxy() {
  let gate: { release: () => void; opened: Promise<void> } | undefined;
  const heldNow = new Set<string>();
  const upstream = new URL(upstreamOrigin!);
  const server = Bun.serve<ProxySocket>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const upgraded = server.upgrade(request, {
          headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
          data: { path: url.pathname + url.search, protocol, pending: [] },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
      }
      if (url.pathname === "/auth/logout" || url.pathname.endsWith("/auth/logout"))
        return new Response("signed out (stand-in for Authing)", { status: 200 });
      const name = chatReadIds.get(url.pathname.split("/_serverFn/")[1] ?? "");
      if (gate && name) {
        const held = `${name} ${heldNow.size}`;
        heldNow.add(held);
        await gate.opened;
        heldNow.delete(held);
      }
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("origin", upstream.origin);
      forwardHeaders.delete("referer");
      const response = await fetch(upstream.origin + url.pathname + url.search, {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        // @ts-expect-error Bun's fetch streams a request body only with `duplex`.
        duplex: "half",
      });
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      const location = headers.get("location");
      if (location)
        headers.set(
          "location",
          location.replace(upstream.origin, `http://127.0.0.1:${server.port}`),
        );
      return new Response(response.body, { status: response.status, headers });
    },
    websocket: {
      open(client) {
        const target = `ws://${upstream.host}${client.data.path}`;
        const socket = new WebSocket(target, client.data.protocol);
        socket.binaryType = "arraybuffer";
        client.data.upstream = socket;
        socket.onopen = () => {
          for (const message of client.data.pending) socket.send(message);
          client.data.pending.length = 0;
        };
        socket.onmessage = (event) => client.send(event.data);
        socket.onclose = (event) => client.close(event.code, event.reason);
        socket.onerror = () => client.close(1011, "Upstream WebSocket error");
      },
      message(client, message) {
        const socket = client.data.upstream;
        if (socket?.readyState === WebSocket.OPEN) socket.send(message);
        else client.data.pending.push(message);
      },
      close(client) {
        client.data.upstream?.close();
      },
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    /** From now on the Chat reads wait for `release()`. */
    hold() {
      let release: () => void = () => {};
      const opened = new Promise<void>((resolve) => (release = resolve));
      gate = { release, opened };
    },
    release() {
      gate?.release();
      gate = undefined;
    },
    /** How many held reads are waiting right now. */
    held: () => heldNow.size,
    stop: () => server.stop(true),
  };
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = gatedProxy();
const session = `query-cache-persistence-${process.pid}`;

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
/** Waits for `condition` in the page, failing with its text rather than at the test timeout. */
const waitFor = (condition: string, ms = 20_000) =>
  Promise.race([
    browser("wait", "--fn", condition),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
    ),
  ]);
/** Runs an async expression in the page and parses the JSON it returns. */
async function evaluate<T>(expression: string): Promise<T> {
  const printed = (
    await browser("eval", `(async () => JSON.stringify(await (${expression})))()`)
  ).trim();
  return JSON.parse(JSON.parse(printed)) as T;
}

/** The kept queries as IndexedDB holds them, opened without going through the app. */
const withStore = (mode: IDBTransactionMode, body: string) => `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("coforge-query-cache");
    request.onupgradeneeded = () => request.result.createObjectStore("queries");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const store = db.transaction("queries", "${mode}").objectStore("queries");
  const result = await (async () => { ${body} })();
  db.close();
  return result;
})()`;
const storedKeys = () =>
  evaluate<string[]>(
    withStore(
      "readonly",
      `return new Promise((r) => { const q = store.getAllKeys(); q.onsuccess = () => r(q.result); });`,
    ),
  );
const store = (key: string, value: unknown) =>
  evaluate(
    withStore(
      "readwrite",
      `return new Promise((r) => { const q = store.put(${JSON.stringify(value)}, ${JSON.stringify(key)}); q.onsuccess = () => r(true); });`,
    ),
  );
const visible = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
/** The page is up once the layout has stored what the server rendered (its sweep marker). */
const pageIsUp = `(async () => {
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === "coforge-query-cache")) return false;
  const db = await new Promise((r) => { const q = indexedDB.open("coforge-query-cache"); q.onsuccess = () => r(q.result); });
  const keys = await new Promise((r) => { const q = db.transaction("queries").objectStore("queries").getAllKeys(); q.onsuccess = () => r(q.result); });
  db.close();
  return keys.some((key) => String(key).endsWith("/meta/collected-at"));
})()`;

let workspacePath = "";
let workspaceId = "";
const channelName = `e2e-cache-${process.pid}`;
let channelId = "";
const first = `First message ${process.pid}`;
const second = `Second message ${process.pid}`;

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  workspacePath = `/en/w/${membership.workspace.slug}`;
  workspaceId = membership.workspaceId;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName, description: "" },
  });
  channelId = channel.id;
  const member = await db.conversationMember.create({
    data: { conversationId: channelId, workspaceId, userId: DEV_BROWSER_USER.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: member.id,
      sequence: 1,
      body: first,
    },
  });
  await mkdir(artifacts, { recursive: true });
  await browser("set", "viewport", "1440", "900");
});

afterAll(async () => {
  await db.message.deleteMany({ where: { conversationId: channelId } }).catch(() => {});
  await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
  await browser("close").catch(() => undefined);
  proxy.stop();
  await db.$disconnect();
});

const channelKey = (viewerId: string) =>
  `${viewerId}/tanstack-query-["conversation","channel","${channelId}"]`;

test("Chat opens from the browser's copy while its reads are outstanding, then the reads bring it up to date", async () => {
  // A first visit: the browser reads the channel (Chat renders in the browser only), and the page
  // stores what it read.
  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await waitFor(visible(first), 60_000);
  await waitFor(pageIsUp);
  expect(await storedKeys()).toContain(channelKey(DEV_BROWSER_USER.id));

  // Something new arrives while nobody has the channel open.
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: member.id,
      sequence: 2,
      body: second,
    },
  });

  // A new page load away from Chat: nothing of the conversation is in memory.
  await browser("open", `${proxy.origin}${workspacePath}/members`);
  await waitFor(pageIsUp);
  proxy.hold();
  await browser("eval", "window.__stayedInThisDocument = true");
  await browser(
    "eval",
    `[...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Chat").click()`,
  );

  // The sidebar and the conversation are on screen from storage, with the reads still waiting.
  await waitFor(visible(first));
  await waitFor(`document.querySelector('a[href*="/channel/${channelId}"]') !== null`);
  expect(proxy.held()).toBeGreaterThan(0);
  expect(await evaluate<boolean>("window.__stayedInThisDocument === true")).toBe(true);
  expect(await evaluate<boolean>(visible(second))).toBe(false);
  await browser("screenshot", join(artifacts, "from-the-browsers-copy.png"));

  // The reads then answer, and the page catches up.
  proxy.release();
  await waitFor(visible(second));
  await browser("screenshot", join(artifacts, "brought-up-to-date.png"));
}, 300_000);

test("signing out removes what the browser kept", async () => {
  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await waitFor(visible(first), 60_000);
  await waitFor(pageIsUp);
  expect((await storedKeys()).some((key) => key.includes("tanstack-query-"))).toBe(true);

  await browser("eval", `document.querySelector('button[aria-label^="Current user"]').click()`);
  await waitFor(
    `[...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent.trim() === "Sign out")`,
  );
  await browser(
    "eval",
    `[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim() === "Sign out").click()`,
  );

  // The proxy stands in for Authing at `/auth/logout`: a page of this origin that is not the app,
  // so nothing stores again. What is in IndexedDB now is what sign-out left.
  await waitFor(`document.body.innerText.includes("signed out")`);
  expect(await storedKeys()).toEqual([]);
}, 120_000);

test("another person on the same browser starts from nothing", async () => {
  // What an earlier person left: a conversation under their own key, and a secret in it.
  const secret = `Someone else's secret ${process.pid}`;
  await browser("open", `${proxy.origin}/en/health`);
  const earlier = "11111111-1111-4111-8111-111111111111";
  await store(channelKey(earlier), {
    buster: "any",
    queryHash: JSON.stringify(["conversation", "channel", channelId]),
    queryKey: ["conversation", "channel", channelId],
    state: {
      data: {
        pages: [{ conversationId: channelId, messages: [{ id: "m", body: secret }] }],
        pageParams: [undefined],
      },
      dataUpdatedAt: Date.now(),
    },
  });
  expect(await storedKeys()).toEqual([channelKey(earlier)]);

  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await waitFor(visible(first), 60_000);
  await waitFor(pageIsUp);
  expect((await storedKeys()).filter((key) => key.startsWith(`${earlier}/`))).toEqual([]);
  expect(await evaluate<boolean>(visible(secret))).toBe(false);
}, 120_000);
