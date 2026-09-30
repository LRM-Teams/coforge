import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";

/**
 * Chat reads each of its lists once (the channel list, every channel's name, the DM list from its
 * two reads, and the Saved list) when nothing was published between that read and the moment its
 * realtime subscriptions start, and reads a list again when something was that its subscription
 * will never deliver (`rereadMissedBySubscribe`, Centrifugo's read-the-position-first recipe:
 * https://centrifugal.dev/docs/server/history_and_recovery).
 *
 * Opt-in like the other browser E2Es: a real local Web built with `bun run build` and served from
 * `.output/` (`COFORGE_E2E_WEB_URL`, its Server Function ids are read from that build), a real
 * Centrifugo with this repository's `infra/centrifugo/config.yaml` whose proxies and JWKS point at
 * that Web (`COFORGE_E2E_CENTRIFUGO_URL`, and `COFORGE_CENTRIFUGO_API_KEY` to publish), the Web's
 * `COFORGE_CENTRIFUGO_API_URL` pointing at the same Centrifugo, `agent-browser`, and the dev user
 * an owner of its Workspace (seed-dev). The browser talks to a proxy in this test that counts the
 * list reads, can hold the channel list's answer, and forwards `/connection/*` to Centrifugo,
 * noting which channels the browser has asked to subscribe to.
 * Counts are written to `.amp/e2e/sidebar-subscribe-reads/reads.json`.
 */
const upstreamOrigin = Bun.env.COFORGE_E2E_WEB_URL;
if (!upstreamOrigin || !["localhost", "127.0.0.1"].includes(new URL(upstreamOrigin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const centrifugoApiKey = Bun.env.COFORGE_CENTRIFUGO_API_KEY;
if (!centrifugoApiKey) throw new Error("COFORGE_CENTRIFUGO_API_KEY is required");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sidebar-subscribe-reads");

/** The server functions that read Chat's lists (the DM list is two reads). Each one takes the
 * position of the signal channel that keeps its list live before it reads. */
const COUNTED = [
  "listPublicChannels",
  "listChannelNames",
  "listSavedMessages",
  "loadDirectConversationPreferences",
  "loadDirectConversationBadges",
] as const;
type Counted = (typeof COUNTED)[number];
const noReads = (): Record<Counted, number> => ({
  listPublicChannels: 0,
  listChannelNames: 0,
  listSavedMessages: 0,
  loadDirectConversationPreferences: 0,
  loadDirectConversationBadges: 0,
});

/** This build's Server Function ids by export name, as the build states them
 * (`NAME_createServerFn_handler = createServerRpc({ id: "<64 hex>" ...`). */
function serverFunctionIds(): Map<string, Counted> {
  const bundle = join(import.meta.dir, "../.output/server/index.mjs");
  const source = readFileSync(bundle, "utf8");
  const byName = new Map<string, string>();
  const pattern =
    /([A-Za-z0-9_$]+)_createServerFn_handler\s*=\s*createServerRpc\(\{\s*id:\s*"([0-9a-f]{64})"/g;
  for (const [, name, id] of source.matchAll(pattern)) byName.set(name, id);
  const ids = new Map<string, Counted>();
  for (const name of COUNTED) {
    const id = byName.get(name);
    if (!id) throw new Error(`Server Function ${name} is not in ${bundle}`);
    ids.set(id, name);
  }
  return ids;
}
const countedIds = serverFunctionIds();

type ProxySocket = { path: string; protocol?: string; upstream?: WebSocket; pending: unknown[] };

function countingProxy() {
  const reads = noReads();
  /** The watched channels the browser has sent a subscribe command naming. */
  const subscribing = new Set<string>();
  let watched: string[] = [];
  let gate: { opened: Promise<void>; release: () => void } | undefined;
  let heldNow = 0;
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
      const name = countedIds.get(url.pathname.split("/_serverFn/")[1] ?? "");
      if (name) reads[name] += 1;
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
      const body = await response.arrayBuffer();
      // The answer, read at the server already, waits here: what is published meanwhile is newer
      // than the stream position it carries.
      if (name === "listPublicChannels" && gate) {
        heldNow += 1;
        await gate.opened;
        heldNow -= 1;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(body, { status: response.status, headers });
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
        // A subscribe command carries its channel's name as plain bytes in the protobuf frame, so
        // finding the name in a frame the browser sent is enough to know it asked for the
        // channel; nothing is decoded.
        if (client.data.path.startsWith("/connection/")) {
          const frame = typeof message === "string" ? Buffer.from(message) : message;
          for (const channel of watched) if (frame.includes(channel)) subscribing.add(channel);
        }
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
    reads,
    reset() {
      for (const name of COUNTED) reads[name] = 0;
      subscribing.clear();
    },
    /** Notes from now on when the browser subscribes to these channels. */
    watch(channels: string[]) {
      watched = channels;
    },
    /** The browser has asked to subscribe to every watched channel. */
    subscribedToAll: () => watched.every((channel) => subscribing.has(channel)),
    /** From now on the channel list's answers wait for `release()`. */
    hold() {
      let release = () => {};
      const opened = new Promise<void>((resolve) => (release = resolve));
      gate = { opened, release };
    },
    release() {
      gate?.release();
      gate = undefined;
    },
    held: () => heldNow,
    stop: () => server.stop(true),
  };
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = countingProxy();
const session = `sidebar-subscribe-reads-${process.pid}`;
const results: Record<string, Record<Counted, number>> = {};

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

/** Polls a condition this process can observe, failing with its description. */
async function until(description: string, condition: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(50);
  }
}

async function publish(channel: string, data: unknown) {
  const response = await fetch(`${centrifugoOrigin}/api/publish`, {
    method: "POST",
    headers: { "x-api-key": centrifugoApiKey!, "content-type": "application/json" },
    body: JSON.stringify({ channel, data }),
  });
  if (!response.ok) throw new Error(`publish failed (${response.status})`);
  const body = (await response.json()) as { error?: unknown };
  if (body.error) throw new Error(`publish failed (${JSON.stringify(body.error)})`);
}

let workspacePath = "";
let workspaceId = "";

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  workspacePath = `/en/w/${membership.workspace.slug}`;
  workspaceId = membership.workspaceId;
  proxy.watch([
    workspaceConversationChannel(workspaceId),
    userConversationChannel(DEV_BROWSER_USER.id),
  ]);
  await mkdir(artifacts, { recursive: true });
  await browser("set", "viewport", "1440", "900");
});

afterAll(async () => {
  await writeFile(join(artifacts, "reads.json"), `${JSON.stringify(results, null, 2)}\n`);
  proxy.release();
  await browser("close").catch(() => undefined);
  proxy.stop();
  await db.$disconnect();
});

/**
 * Chat has loaded its lists and its realtime is running: every list has been asked for, and the
 * browser has sent the subscribe command for both signal channels (the Workspace channel and the
 * viewer's own). A subscription that finds a list stale re-reads it right after its subscribe
 * reply, which follows the command within a round trip to Centrifugo; the `networkidle` wait that
 * comes next (no request for 500 ms, restarted by a re-read's request) covers that gap. This is a
 * per-browser signal, unlike asking Centrifugo who is subscribed: the `chat` namespace keeps no
 * presence, and its API would also count another tab of the same user on the same channels.
 */
const chatIsLive = () =>
  until(
    "Chat's lists read and both signal channels subscribed",
    () => COUNTED.every((name) => proxy.reads[name] >= 1) && proxy.subscribedToAll(),
  );

test("with nothing published between the reads and the subscriptions, every list is read once", async () => {
  proxy.reset();
  await browser("open", `${proxy.origin}${workspacePath}`);
  await chatIsLive();
  await browser("wait", "--load", "networkidle");
  results.quiet = { ...proxy.reads };
  expect(proxy.reads).toEqual({
    listPublicChannels: 1,
    listChannelNames: 1,
    listSavedMessages: 1,
    loadDirectConversationPreferences: 1,
    loadDirectConversationBadges: 1,
  });
}, 300_000);

test("a publication between the read and the subscriptions has the channel list read again", async () => {
  await browser("open", "about:blank");
  proxy.reset();
  proxy.hold();
  await browser("open", `${proxy.origin}${workspacePath}`);
  await until("the channel list's answer to be held", () => proxy.held() > 0);
  // Published after the list's position was read and before Chat's handlers join the Workspace
  // channel (the Workspace layout already holds it), so they never receive it.
  await publish(workspaceConversationChannel(workspaceId), { type: "e2e.noop" });
  proxy.release();
  await until("the channel list read again", () => proxy.reads.listPublicChannels >= 2);
  await browser("wait", "--load", "networkidle");
  // The publication moved the Workspace channel only, so the channel list is judged stale. Every
  // count is recorded; the channel names, kept live by the same channel, are not asserted because
  // whether their own position was read before the publication depends on the parallel reads.
  results.published = { ...proxy.reads };
  expect(proxy.reads.listPublicChannels).toBe(2);
}, 300_000);
