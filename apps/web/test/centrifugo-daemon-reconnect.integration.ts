import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Centrifuge, State } from "centrifuge";
import { DAEMON_RECONNECT_DISCONNECT } from "@lrm/coforge-sdk/internal";

import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { centrifugoWorkspaceDeletionSignals } from "#src/server/workspaces/deletion.server";

// Deleting a Workspace disconnects exactly its daemons' connections, found through the presence
// of their `daemon:<workspace>:<computer>` channels, and leaves the same person's page and other
// daemons connected. Runs against the Centrifugo image staging uses, with the `daemon` namespace
// exactly as `infra/centrifugo/config.yaml` declares it. Docker required: `mise run
// test:centrifugo`.

const API_KEY = "daemon-reconnect-integration";
const USER = "user-1";

let root: string;
let containerName: string;
let centrifugoPort: number;
let proxy: ReturnType<typeof Bun.serve>;

/** The connect proxy subscribes each connection to the channel its connect data names, server
 * side, the way the Web proxy subscribes a daemon to its control channel. */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "coforge-daemon-reconnect-"));
  proxy = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { data?: { channel?: string } };
      const channel = body.data?.channel;
      return Response.json({
        result: { user: USER, ...(channel ? { subs: { [channel]: {} } } : {}) },
      });
    },
  });
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  centrifugoPort = portProbe.port!;
  portProbe.stop(true);
  const shipped = Bun.YAML.parse(
    await Bun.file(join(import.meta.dir, "../../../infra/centrifugo/config.yaml")).text(),
  ) as { channel: { namespaces: { name: string }[] } };
  const daemon = shipped.channel.namespaces.find((namespace) => namespace.name === "daemon");
  if (!daemon) throw new Error("infra/centrifugo/config.yaml declares no daemon namespace");
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      health: { enabled: true },
      log: { level: "error" },
      http_api: { key: API_KEY },
      client: {
        proxy: {
          connect: {
            enabled: true,
            endpoint: `http://host.docker.internal:${proxy.port}/connect`,
            timeout: "5s",
          },
        },
      },
      channel: { namespaces: [daemon, { name: "chat" }] },
    }),
    { mode: 0o644 },
  );
  containerName = `coforge-daemon-reconnect-${crypto.randomUUID()}`;
  const docker = Bun.spawnSync([
    "docker",
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1:${centrifugoPort}:8000`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--volume",
    `${configPath}:/centrifugo/config.json:ro`,
    "centrifugo/centrifugo:v6.9.2",
    "centrifugo",
    "--config",
    "/centrifugo/config.json",
  ]);
  if (docker.exitCode !== 0) throw new Error(docker.stderr.toString());
  const deadline = Date.now() + 30_000;
  while (
    (await fetch(`http://127.0.0.1:${centrifugoPort}/health`).catch(() => null))?.ok !== true
  ) {
    if (Date.now() > deadline) throw new Error("Centrifugo did not become healthy");
    await Bun.sleep(100);
  }
}, 60_000);

afterAll(async () => {
  if (containerName) Bun.spawnSync(["docker", "rm", "--force", containerName]);
  proxy?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

/** A connected client of `USER`, subscribed server side to `channel` when one is given, with the
 * disconnect codes it has seen. */
async function connectedClient(channel?: string) {
  const client = new Centrifuge(`ws://127.0.0.1:${centrifugoPort}/connection/websocket`, {
    data: channel ? { channel } : {},
    minReconnectDelay: 50,
    maxReconnectDelay: 50,
  });
  const disconnects: number[] = [];
  const subscribed = new Promise<void>((resolve) => {
    if (!channel) return resolve();
    client.on("subscribed", (context) => {
      if (context.channel === channel) resolve();
    });
  });
  client.on("connecting", (context) => {
    if (context.code >= 3000) disconnects.push(context.code);
  });
  client.on("disconnected", (context) => disconnects.push(context.code));
  client.connect();
  await client.ready(10_000);
  await subscribed;
  return { client, disconnects };
}

test("a deleted Workspace's daemons reconnect; the same person's page and other daemon stay connected", async () => {
  const api = createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: `http://127.0.0.1:${centrifugoPort}/api`,
    COFORGE_CENTRIFUGO_API_KEY: API_KEY,
  });
  const deletedDaemon = await connectedClient("daemon:ws-deleted:computer-1");
  const otherDaemon = await connectedClient("daemon:ws-kept:computer-1");
  const page = await connectedClient();
  try {
    await centrifugoWorkspaceDeletionSignals(() => api).reconnectDaemons("ws-deleted", [
      "computer-1",
      "computer-offline",
    ]);
    const deadline = Date.now() + 10_000;
    while (!deletedDaemon.disconnects.length && Date.now() < deadline) await Bun.sleep(20);

    expect(deletedDaemon.disconnects).toContain(DAEMON_RECONNECT_DISCONNECT.code);
    // It reconnects by itself, as the code asks.
    await deletedDaemon.client.ready(10_000);
    expect(otherDaemon.disconnects).toEqual([]);
    expect(page.disconnects).toEqual([]);
    expect(otherDaemon.client.state).toBe(State.Connected);
    expect(page.client.state).toBe(State.Connected);
  } finally {
    for (const { client } of [deletedDaemon, otherDaemon, page]) client.disconnect();
  }
}, 30_000);
