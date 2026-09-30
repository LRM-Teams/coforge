import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * A channel read on another device moves the read cursor this device keeps for it: the stored
 * window takes the cursor `channel.marked.v1` carries, and opening the channel here draws no
 * "New messages" divider over what was read there (Slack's `channel_marked` carries it as `ts`).
 *
 * Two devices are two `agent-browser` sessions, each its own profile (cookies, IndexedDB), signed in
 * as the same dev user. Opt-in like the other browser E2Es: a real local Web built with
 * `bun run build` and served from `.output/` (`COFORGE_E2E_WEB_URL`), a real Centrifugo with this
 * repository's `infra/centrifugo/config.yaml` whose proxies and JWKS point at that Web
 * (`COFORGE_E2E_CENTRIFUGO_URL`), the Web's `COFORGE_CENTRIFUGO_API_URL` pointing at the same
 * Centrifugo, `agent-browser`, and the dev user an owner of its Workspace (seed-dev). Both browsers
 * talk to a proxy in this test that forwards `/connection/*` to Centrifugo and the rest to the Web.
 * Each run seeds two channels and a second member who writes in them, and removes them afterwards.
 * Screenshots are written under `.amp/e2e/read-cursor-elsewhere/`.
 */
const upstreamOrigin = Bun.env.COFORGE_E2E_WEB_URL;
if (!upstreamOrigin || !["localhost", "127.0.0.1"].includes(new URL(upstreamOrigin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/read-cursor-elsewhere");

type ProxySocket = { path: string; protocol?: string; upstream?: WebSocket; pending: unknown[] };

/** Same origin for the page and its realtime: the Web for pages and reads, Centrifugo for
 * `/connection/*`, as Caddy splits them in production. */
function sameOriginProxy() {
  const upstream = new URL(upstreamOrigin!);
  const centrifugo = new URL(centrifugoOrigin!);
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
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("origin", upstream.origin);
      forwardHeaders.delete("referer");
      const init: RequestInit & { duplex: "half" } = {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        duplex: "half",
      };
      const response = await fetch(upstream.origin + url.pathname + url.search, init);
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(response.body, { status: response.status, headers });
    },
    websocket: {
      open(client) {
        const target = client.data.path.startsWith("/connection/")
          ? `ws://${centrifugo.host}${client.data.path}`
          : `ws://${upstream.host}${client.data.path}`;
        // Sent without an Origin header, which Centrifugo's `allowed_origins` check lets through.
        const socket = new WebSocket(target, client.data.protocol);
        socket.binaryType = "arraybuffer";
        client.data.upstream = socket;
        socket.onopen = () => {
          for (const message of client.data.pending) socket.send(message as string);
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
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = sameOriginProxy();

/** One device: its own `agent-browser` session, so its own cookies and IndexedDB. */
function device(name: string) {
  const session = `read-cursor-elsewhere-${name}-${process.pid}`;
  async function run(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${name}: ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** Runs an async expression in the page and parses the JSON it returns. */
  async function evaluate<T>(expression: string): Promise<T> {
    const printed = (
      await run("eval", `(async () => JSON.stringify(await (${expression})))()`)
    ).trim();
    return JSON.parse(JSON.parse(printed)) as T;
  }
  /** Polls an asynchronous condition in the page (`wait --fn` takes a Promise as truthy). */
  async function until(condition: string, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await evaluate<boolean>(condition))) {
      if (Date.now() > deadline) throw new Error(`${name}: timed out waiting for ${condition}`);
      await Bun.sleep(100);
    }
  }
  return { run, evaluate, until };
}
const here = device("here");
const elsewhere = device("elsewhere");

const suffix = String(process.pid);
let workspacePath = "";
let workspaceId = "";
let readId = "";
let otherId = "";
let writerUserId = "";
let writerMemberId = "";
let viewerMemberId = "";
const body = (n: number) => `Read-cursor message ${n} ${suffix}`;
const otherBody = `Somewhere else ${suffix}`;

const visible = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const dividerShown = `document.querySelector('[role="separator"][aria-label="New messages"]') !== null`;
/** The read cursor this device stores for the channel, straight from IndexedDB. */
const storedCursor = () => `(async () => {
  const db = await new Promise((r, j) => { const q = indexedDB.open("coforge-query-cache"); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const row = await new Promise((r) => { const q = db.transaction("queries").objectStore("queries").get(${JSON.stringify(
    `${DEV_BROWSER_USER.id}/tanstack-query-["conversation","channel","${readId}"]`,
  )}); q.onsuccess = () => r(q.result); });
  db.close();
  return row?.state?.data?.pages?.[0]?.readThroughSequence ?? null;
})()`;
const clickChannel = (id: string) => `document.querySelector('a[href*="/channel/${id}"]').click()`;

async function post(conversationId: string, sequence: number, text: string) {
  await db.message.create({
    data: { workspaceId, conversationId, senderMemberId: writerMemberId, sequence, body: text },
  });
}

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  workspacePath = `/en/w/${membership.workspace.slug}`;
  workspaceId = membership.workspaceId;
  const writer = await db.user.create({ data: { username: `e2erc${suffix}` } });
  writerUserId = writer.id;
  await db.workspaceMembership.create({ data: { workspaceId, userId: writer.id } });
  const read = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-read-${suffix}`, description: "" },
  });
  const other = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-other-${suffix}`, description: "" },
  });
  readId = read.id;
  otherId = other.id;
  const writerMember = await db.conversationMember.create({
    data: { conversationId: readId, workspaceId, userId: writer.id },
  });
  writerMemberId = writerMember.id;
  await db.conversationMember.create({
    data: { conversationId: otherId, workspaceId, userId: writer.id },
  });
  // The viewer has read the first three messages; nothing is unread when the test starts.
  const viewer = await db.conversationMember.create({
    data: { conversationId: readId, workspaceId, userId: DEV_BROWSER_USER.id },
  });
  viewerMemberId = viewer.id;
  await db.conversationMember.create({
    data: { conversationId: otherId, workspaceId, userId: DEV_BROWSER_USER.id },
  });
  for (const n of [1, 2, 3]) await post(readId, n, body(n));
  await db.conversationMember.update({
    where: { id: viewerMemberId },
    data: { readThroughSequence: 3 },
  });
  const writerInOther = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: otherId, userId: writer.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: otherId,
      senderMemberId: writerInOther.id,
      sequence: 1,
      body: otherBody,
    },
  });
  await mkdir(artifacts, { recursive: true });
  for (const one of [here, elsewhere]) await one.run("set", "viewport", "1440", "900");
});

afterAll(async () => {
  for (const one of [here, elsewhere]) await one.run("close").catch(() => undefined);
  proxy.stop();
  await db.message.deleteMany({ where: { conversationId: { in: [readId, otherId] } } });
  await db.conversationMember.deleteMany({ where: { conversationId: { in: [readId, otherId] } } });
  await db.conversation.deleteMany({ where: { id: { in: [readId, otherId] } } });
  await db.workspaceMembership.deleteMany({ where: { userId: writerUserId } });
  await db.user.deleteMany({ where: { id: writerUserId } });
  await db.$disconnect();
});

test("a channel read on another device opens here without a divider over what was read", async () => {
  // This device reads the channel, stores it at cursor 3, and moves on to another channel.
  await here.run("open", `${proxy.origin}${workspacePath}/channel/${readId}`);
  await here.until(visible(body(3)), 60_000);
  await here.until(`${storedCursor()}.then((cursor) => cursor === 3)`);
  await here.run("eval", clickChannel(otherId));
  await here.until(visible(otherBody));

  // Two new messages arrive, and the other device reads them.
  await post(readId, 4, body(4));
  await post(readId, 5, body(5));
  await elsewhere.run("open", `${proxy.origin}${workspacePath}/channel/${readId}`);
  await elsewhere.until(visible(body(5)), 60_000);
  const deadline = Date.now() + 30_000;
  while (
    (await db.conversationMember.findUniqueOrThrow({ where: { id: viewerMemberId } }))
      .readThroughSequence !== 5
  ) {
    if (Date.now() > deadline) throw new Error("the other device did not read through message 5");
    await Bun.sleep(200);
  }

  // This device's stored window takes the cursor the read carried.
  await here.until(`${storedCursor()}.then((cursor) => cursor === 5)`);

  // Opening the channel here, from memory, draws no divider over what the other device read.
  await here.run("eval", clickChannel(readId));
  await here.until(visible(body(5)));
  expect(await here.evaluate<boolean>(dividerShown)).toBe(false);
  await here.run("screenshot", join(artifacts, "opened-from-memory.png"));

  // Nor does a new page load, which opens it from storage.
  await here.run("open", `${proxy.origin}${workspacePath}/channel/${readId}`);
  await here.until(visible(body(5)), 60_000);
  expect(await here.evaluate<boolean>(dividerShown)).toBe(false);
  await here.run("screenshot", join(artifacts, "opened-from-storage.png"));
}, 300_000);
