import { Centrifuge } from "centrifuge/build/protobuf";

const directory = import.meta.dir;
const compose = ["docker", "compose", "-p", "lrm1589-fixed", "-f", `${directory}/compose.yaml`];
const edge = "http://127.0.0.1:18089";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const results: Record<string, unknown>[] = [];

type LiveClient = {
  client: Centrifuge;
  events: Record<string, unknown>[];
  subscription: ReturnType<Centrifuge["newSubscription"]>;
};

function emit(fault: string, observation: Record<string, unknown>) {
  const result = { fault, ...observation };
  results.push(result);
  console.log(JSON.stringify(result));
}

function command(args: string[], allowFailure = false) {
  const started = performance.now();
  const result = Bun.spawnSync(args, { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const durationMs = Math.round(performance.now() - started);
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${result.stderr.toString()}`);
  }
  return { args, durationMs, result };
}

async function waitForHttp(url: string, timeout = 20_000) {
  const started = performance.now();
  let failures = 0;
  while (performance.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return { failures, recoveryMs: Math.round(performance.now() - started) };
    } catch {
      // The selected service is still recovering.
    }
    failures++;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function connect(accessToken: string, channel: string, url: string): Promise<LiveClient> {
  const events: Record<string, unknown>[] = [];
  const client = new Centrifuge(url, {
    data: encoder.encode(JSON.stringify({ accessToken })),
    timeout: 1_000,
    minReconnectDelay: 100,
    maxReconnectDelay: 300,
    websocket: WebSocket,
  });
  for (const event of ["connecting", "connected", "disconnected"] as const) {
    client.on(event, (context) =>
      events.push({ event, at: Date.now(), code: "code" in context ? context.code : undefined }),
    );
  }
  const subscription = client.newSubscription(channel, { recoverable: true, positioned: true });
  subscription.subscribe();
  client.connect();
  await Promise.all([client.ready(5_000), subscription.ready(5_000)]);
  events.length = 0;
  return { client, events, subscription };
}

async function rpc(client: Centrifuge, id: string) {
  return client.rpc(
    "message.publish",
    encoder.encode(
      JSON.stringify({
        clientMessageId: id,
        conversationId: "conversation:alpha",
        text: id,
      }),
    ),
  );
}

async function rpcEventually(client: Centrifuge, id: string, timeout = 15_000) {
  const started = performance.now();
  let failures = 0;
  while (performance.now() - started < timeout) {
    try {
      const response = await rpc(client, id);
      return {
        failures,
        recoveryMs: Math.round(performance.now() - started),
        response: JSON.parse(decoder.decode(response.data)),
      };
    } catch {
      failures++;
      await Bun.sleep(100);
    }
  }
  return { failures, recoveryMs: null, response: null };
}

async function api(port: number, method: "presence" | "history", channel: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "lrm-1583-disposable-api-key",
      },
      body: JSON.stringify({ channel, limit: 100 }),
    });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: 0, error: String(error) };
  }
}

async function online(channel: string) {
  const response = await fetch(
    `${edge}/test-control/online?channel=${encodeURIComponent(channel)}`,
  );
  return { status: response.status, body: await response.json() };
}

function nextPublication(subscription: LiveClient["subscription"], timeout = 5_000) {
  return Promise.race([
    new Promise<unknown>((resolve) =>
      subscription.once("publication", (context) =>
        resolve(JSON.parse(decoder.decode(context.data))),
      ),
    ),
    Bun.sleep(timeout).then(() => null),
  ]);
}

async function waitForReconnect(events: Record<string, unknown>[], startedAt: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const connectingIndex = events.findIndex((event) => event.event === "connecting");
    const connected = events
      .slice(connectingIndex + 1)
      .find((event) => event.event === "connected");
    if (connectingIndex >= 0 && typeof connected?.at === "number") {
      return connected.at - startedAt;
    }
    await Bun.sleep(50);
  }
  throw new Error("client did not reconnect within 15 seconds");
}

async function main() {
  command([...compose, "config", "--quiet"]);
  const up = command([...compose, "up", "-d", "--build", "--wait"]);
  await waitForHttp(`${edge}/health`);
  emit("versions", {
    baselineCommit: "d106038e2e9cd04d0b764954bd55a354470374be",
    upCommand: up.args.join(" "),
    upMs: up.durationMs,
    images: {
      bun: "1.4.0-alpine",
      caddy: "2.10.2-alpine",
      centrifugo: "v6.9.3",
      redis: "7.4.5-alpine",
      centrifugeJs: "5.7.0",
    },
  });

  const alice = await connect(
    "alice-token",
    "conversation:alpha",
    "ws://127.0.0.1:18089/connection/websocket",
  );
  const bob = await connect(
    "bob-token",
    "conversation:beta",
    "ws://127.0.0.1:18089/connection/websocket",
  );

  const backendCommands = [];
  const stopA = command([...compose, "stop", "backend-a"]);
  backendCommands.push({ command: stopA.args.join(" "), durationMs: stopA.durationMs });
  const viaB = await rpcEventually(alice.client, "rolling-via-b");
  const startA = command([...compose, "start", "backend-a"]);
  backendCommands.push({ command: startA.args.join(" "), durationMs: startA.durationMs });
  await waitForHttp(`${edge}/health`);
  const stopB = command([...compose, "stop", "backend-b"]);
  backendCommands.push({ command: stopB.args.join(" "), durationMs: stopB.durationMs });
  const viaA = await rpcEventually(alice.client, "rolling-via-a");
  const startB = command([...compose, "start", "backend-b"]);
  backendCommands.push({ command: startB.args.join(" "), durationMs: startB.durationMs });
  await waitForHttp(`${edge}/health`);

  const stopBoth = command([...compose, "stop", "backend-a", "backend-b"]);
  backendCommands.push({ command: stopBoth.args.join(" "), durationMs: stopBoth.durationMs });
  let outageFailure = false;
  const outageStarted = performance.now();
  try {
    await rpc(alice.client, "backend-outage-must-fail");
  } catch {
    outageFailure = true;
  }
  const failureObservedMs = Math.round(performance.now() - outageStarted);
  const startBoth = command([...compose, "start", "backend-a", "backend-b"]);
  backendCommands.push({ command: startBoth.args.join(" "), durationMs: startBoth.durationMs });
  const recovered = await rpcEventually(alice.client, "backend-recovered");
  emit("backend-rolling", {
    commands: backendCommands,
    viaB,
    viaA,
    outageFailure,
    failureObservedMs,
    recovered,
    wssEvents: [...alice.events, ...bob.events],
    onlineAlpha: await online("conversation:alpha"),
    onlineBeta: await online("conversation:beta"),
  });

  const directA = await connect(
    "alice-token",
    "conversation:alpha",
    "ws://127.0.0.1:18189/connection/websocket",
  );
  const directB = await connect(
    "alice-token",
    "conversation:alpha",
    "ws://127.0.0.1:18289/connection/websocket",
  );
  const crossReplicaPublication = nextPublication(directB.subscription);
  await rpc(directA.client, "cross-replica-before-redis");
  emit("cross-replica-baseline", {
    publicationOnReplicaB: await crossReplicaPublication,
    presenceA: await api(18189, "presence", "conversation:alpha"),
    presenceB: await api(18289, "presence", "conversation:alpha"),
    historyA: await api(18189, "history", "conversation:alpha"),
    historyB: await api(18289, "history", "conversation:alpha"),
  });

  alice.events.length = 0;
  bob.events.length = 0;
  directA.events.length = 0;
  directB.events.length = 0;
  const stopRedis = command([...compose, "stop", "redis"]);
  const redisOutageStarted = performance.now();
  let redisPublishFailed = false;
  try {
    await rpc(directA.client, "redis-outage-must-fail");
  } catch {
    redisPublishFailed = true;
  }
  const presenceDuring = await api(18189, "presence", "conversation:alpha");
  const historyDuring = await api(18189, "history", "conversation:alpha");
  const startRedis = command([...compose, "start", "redis"]);
  const redisRecovered = await rpcEventually(directA.client, "after-redis-restart", 20_000);
  const historyAfter = await api(18189, "history", "conversation:alpha");
  emit("redis-restart", {
    commands: [
      { command: stopRedis.args.join(" "), durationMs: stopRedis.durationMs },
      { command: startRedis.args.join(" "), durationMs: startRedis.durationMs },
    ],
    outageToRecoveryMs: Math.round(performance.now() - redisOutageStarted),
    redisPublishFailed,
    presenceDuring,
    historyDuring,
    redisRecovered,
    historyAfter,
    wssEvents: [...alice.events, ...bob.events, ...directA.events, ...directB.events],
  });

  directA.events.length = 0;
  directB.events.length = 0;
  const restartAStarted = Date.now();
  const restartA = command([...compose, "restart", "centrifugo-a"]);
  const reconnectA = await waitForReconnect(directA.events, restartAStarted);
  const afterA = await rpcEventually(directB.client, "after-centrifugo-a-restart");
  const restartBStarted = Date.now();
  const restartB = command([...compose, "restart", "centrifugo-b"]);
  const reconnectB = await waitForReconnect(directB.events, restartBStarted);
  const afterB = await rpcEventually(directA.client, "after-centrifugo-b-restart");
  emit("centrifugo-rolling", {
    commands: [
      { command: restartA.args.join(" "), durationMs: restartA.durationMs },
      { command: restartB.args.join(" "), durationMs: restartB.durationMs },
    ],
    reconnectA,
    reconnectB,
    afterA,
    afterB,
    eventsA: directA.events,
    eventsB: directB.events,
    presenceA: await api(18189, "presence", "conversation:alpha"),
    presenceB: await api(18289, "presence", "conversation:alpha"),
  });

  alice.events.length = 0;
  bob.events.length = 0;
  const network = "lrm1589-fixed_default";
  const edgeContainer = "lrm1589-fixed-edge-1";
  const disconnect = command(["docker", "network", "disconnect", network, edgeContainer]);
  const networkOutageStarted = performance.now();
  await Bun.sleep(500);
  const rpcDuringNetwork = await rpcEventually(alice.client, "during-network-outage", 2_500);
  const reconnect = command([
    "docker",
    "network",
    "connect",
    "--alias",
    "edge",
    network,
    edgeContainer,
  ]);
  await Promise.all([alice.client.ready(15_000), bob.client.ready(15_000)]);
  const rpcAfterNetwork = await rpcEventually(alice.client, "after-network-recovery");
  emit("network-interruption", {
    commands: [
      { command: disconnect.args.join(" "), durationMs: disconnect.durationMs },
      { command: reconnect.args.join(" "), durationMs: reconnect.durationMs },
    ],
    outageToRecoveryMs: Math.round(performance.now() - networkOutageStarted),
    rpcDuringNetwork,
    rpcAfterNetwork,
    events: [...alice.events, ...bob.events],
    onlineAlpha: await online("conversation:alpha"),
    onlineBeta: await online("conversation:beta"),
  });

  for (const live of [alice, bob, directA, directB]) live.client.disconnect();
  emit("summary", { observations: results.length });
}

try {
  await main();
} finally {
  const down = command([...compose, "down", "--volumes", "--remove-orphans"], true);
  console.log(
    JSON.stringify({
      fault: "cleanup",
      command: down.args.join(" "),
      durationMs: down.durationMs,
      exitCode: down.result.exitCode,
    }),
  );
}
