import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_CONNECT_REJECTION_CODES } from "@lrm/coforge-sdk/internal";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { DaemonConnectionRefusedError } from "#src/connection/daemon-connection-refused-error";

// Runs the Daemon's real connection against the Centrifugo image staging uses, behind a connect
// proxy that answers the way the Web proxy does. Run it explicitly (Docker required):
//   bun test ./packages/daemon/test/daemon-connection-refusal.integration.ts

const WORKSPACE_ID = "0f3c2b8e-5d6a-4c1e-9b7f-2a4d6e8f0a1b";
const COMPUTER_ID = "0f3c2b8e-5d6a-4c1e-9b7f-2a4d6e8f0a1c";
const API_KEY = "refusal-integration";

let root: string;
let containerName: string;
let centrifugoPort: number;
let proxy: ReturnType<typeof Bun.serve>;
/** What the connect proxy answers next: accept, refuse for good, or fail the way a bad key does. */
let answer: "accept" | "workspace_deleted" | "unauthorized" = "accept";
let connectAttempts = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "coforge-connection-refusal-"));
  proxy = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch() {
      connectAttempts++;
      if (answer === "workspace_deleted")
        return Response.json({
          disconnect: { code: DAEMON_CONNECT_REJECTION_CODES.workspace_deleted, reason: answer },
        });
      if (answer === "unauthorized")
        return Response.json({ error: { code: 401, message: "unauthorized" } }, { status: 401 });
      return Response.json({
        result: {
          user: "user-1",
          subs: { [`daemon:${WORKSPACE_ID}:${COMPUTER_ID}`]: {} },
        },
      });
    },
  });
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  centrifugoPort = portProbe.port!;
  portProbe.stop(true);
  const configPath = join(root, "centrifugo.yaml");
  await writeFile(
    configPath,
    `health:\n  enabled: true\nlog:\n  level: error\nhttp_api:\n  key: ${API_KEY}\nclient:\n  proxy:\n    connect:\n      enabled: true\n      endpoint: http://host.docker.internal:${proxy.port}/connect\n      timeout: 5s\nchannel:\n  namespaces:\n    - name: daemon\n`,
    { mode: 0o644 },
  );
  containerName = `coforge-connection-refusal-${crypto.randomUUID()}`;
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
    `${configPath}:/centrifugo/config.yaml:ro`,
    "centrifugo/centrifugo:v6.9.2",
    "centrifugo",
    "--config",
    "/centrifugo/config.yaml",
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

const endpoint = () => `ws://127.0.0.1:${centrifugoPort}/connection/websocket`;
const config = { workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID };

test("a refusal on the first connect fails start with its reason and never reconnects", async () => {
  answer = "workspace_deleted";
  connectAttempts = 0;
  const connection = new DaemonConnection(endpoint());

  const failure = await connection.start("dk_unknown", config).catch((error: unknown) => error);
  await Bun.sleep(3_000);

  expect(failure).toBeInstanceOf(DaemonConnectionRefusedError);
  expect(failure).toMatchObject({ reason: "workspace_deleted" });
  expect(connectAttempts).toBe(1);
  await connection.stop();
}, 30_000);

test("a refusal when a running connection reconnects reaches the refusal listener and ends reconnecting", async () => {
  answer = "accept";
  connectAttempts = 0;
  const connection = new DaemonConnection(endpoint());
  const refused = Promise.withResolvers<string>();
  connection.onConnectionRefused((reason) => refused.resolve(reason));
  await connection.start("dk_known", config);

  // The Workspace is deleted, then the server drops the connection with a reconnect code.
  answer = "workspace_deleted";
  const disconnect = await fetch(`http://127.0.0.1:${centrifugoPort}/api/disconnect`, {
    method: "POST",
    headers: { Authorization: `apikey ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user: "user-1", disconnect: { code: 3001, reason: "shutdown" } }),
  });
  expect(disconnect.status).toBe(200);

  expect(await refused.promise).toBe("workspace_deleted");
  const attemptsAtRefusal = connectAttempts;
  await Bun.sleep(3_000);
  expect(attemptsAtRefusal).toBe(2);
  expect(connectAttempts).toBe(attemptsAtRefusal);
  await connection.stop();
}, 30_000);

test("an ordinary authentication failure stays a temporary error, not a refusal", async () => {
  answer = "unauthorized";
  const connection = new DaemonConnection(endpoint());

  const failure = await connection.start("dk_bad", config).catch((error: unknown) => error);

  expect(failure).not.toBeInstanceOf(DaemonConnectionRefusedError);
  expect(failure).toMatchObject({ error: { code: 100, temporary: true } });
  await connection.stop();
}, 30_000);
