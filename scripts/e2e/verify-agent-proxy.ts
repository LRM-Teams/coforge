import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoforgeDriver, PiDriver } from "../../packages/daemon/src/code-agent/pi/driver";

const names = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENROUTER_API_KEY",
];
const before = Object.fromEntries(names.map((name) => [name, Bun.env[name]]));
const root = await mkdtemp(join(tmpdir(), "coforge-real-proxy-"));
const results: unknown[] = [];
function proxy() {
  const requests: string[] = [];
  const connections: string[] = [];
  let received!: () => void;
  const observed = new Promise<void>((resolve) => {
    received = resolve;
  });
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const firstLine = new TextDecoder().decode(data).split("\r\n")[0];
        connections.push(firstLine ?? "<empty request>");
        if (firstLine?.startsWith("CONNECT openrouter.ai:443 ")) {
          requests.push("CONNECT openrouter.ai:443");
          received();
        }
        socket.end(
          "HTTP/1.1 502 Local proxy test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
      },
      error() {},
    },
  });
  return {
    requests,
    connections,
    observed,
    listener,
    url: `http://127.0.0.1:${listener.port}`,
  };
}
try {
  for (const name of names) delete Bun.env[name];
  // A synthetic key makes the SDK attempt its request. No real credential is used.
  Bun.env.OPENROUTER_API_KEY = "local-proxy-test-not-a-real-key";
  for (const provider of ["pi", "coforge"] as const) {
    for (const overridden of [false, true]) {
      console.log(JSON.stringify({ starting: provider, overridden }));
      const inherited = proxy();
      const custom = proxy();
      Bun.env.HTTPS_PROXY = inherited.url;
      const workspace = join(root, `${provider}-${overridden ? "override" : "inherited"}`);
      await mkdir(workspace);
      const driver = provider === "coforge" ? new CoforgeDriver() : new PiDriver();
      let session: Awaited<ReturnType<typeof driver.createAgentSession>> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sendError: unknown;
      try {
        session = await driver.createAgentSession({
          agentWorkspaceDirectory: workspace,
          instructions: "This is a local proxy connectivity test. Do not use tools.",
          runtime: {
            provider,
            modelProvider: "openrouter",
            model: "openai/gpt-4o-mini",
            ...(provider === "coforge"
              ? {
                  providerConfig: {
                    kind: "coforge" as const,
                    providerId: "openrouter" as const,
                    apiKey: "local-proxy-test-not-a-real-key",
                  },
                }
              : {}),
            ...(overridden ? { envVars: { HTTPS_PROXY: custom.url } } : {}),
          },
        });
        const sent = session.sendMessage("Reply with proxy test.").catch((error: unknown) => {
          sendError = error;
          throw error;
        });
        await Promise.race([
          (overridden ? custom : inherited).observed,
          sent.then(() => {
            throw new Error("Model request completed without reaching the expected proxy");
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `No OpenRouter CONNECT observed within 20s; sendMessage=${safeError(sendError)}; inherited=${JSON.stringify(inherited.connections)}; override=${JSON.stringify(custom.connections)}`,
                  ),
                ),
              20_000,
            );
          }),
        ]);
        if ((overridden ? inherited : custom).requests.length)
          throw new Error("Wrong proxy received request");
        results.push({
          case: overridden ? "explicit override wins" : "local HTTPS_PROXY inherited",
          runtime: provider === "pi" ? "Pi SDK" : "CoForge Pi SDK",
          productionSeam: `${driver.constructor.name}.createAgentSession → Pi SDK → model request`,
          customEnvironmentProvided: overridden,
          observed: (overridden ? custom : inherited).requests[0],
          otherProxyRequests: 0,
          passed: true,
        });
      } finally {
        if (timer) clearTimeout(timer);
        await session?.dispose();
        inherited.listener.stop(true);
        custom.listener.stop(true);
      }
    }
  }
  const evidence = {
    timestamp: new Date().toISOString(),
    results,
    limitation:
      "Local proxy intentionally returns 502; proves SDK model-request proxy routing, not successful model output or OS service-manager environment injection. No real credential used or recorded.",
  };
  await Bun.write(
    new URL("../../.amp/in/artifacts/proxy-inheritance.json", import.meta.url),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const name of names) {
    if (before[name] === undefined) delete Bun.env[name];
    else Bun.env[name] = before[name];
  }
  await rm(root, { recursive: true, force: true });
}

function safeError(error: unknown): string {
  if (error === undefined) return "pending";
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
