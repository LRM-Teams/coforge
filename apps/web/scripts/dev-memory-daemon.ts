/**
 * Dev-only daemon host for the workspace Memory Agent (ADR 0052/0053).
 *
 * Boots a REAL DaemonRuntime against the local dev stack (web on 8788,
 * Centrifugo on 18000, dev Postgres), registers a dedicated Computer, hosts
 * the workspace's Memory Agent with the real CoForge (Pi) provider, and stays
 * alive so channel deliveries wake the fenced memory explorer for real — the
 * live half of the memory-agent verification ADR 0053 keeps alongside the
 * regression suite.
 *
 * Env (see scripts/local/dev-memory-daemon.sh for the full wiring):
 *   DATABASE_URL                                dev Postgres (required)
 *   DEV_SERVER_HTTP_URL       default http://127.0.0.1:8788
 *   DEV_CENTRIFUGO_WS         default ws://127.0.0.1:18000/connection/websocket
 *   DEV_MEMORY_MODEL          default DeepSeek-V4-Flash-0731
 *   DEV_MEMORY_MODEL_PROVIDER default lenovo-deepseek-v4-flash
 *
 * Run: bash scripts/local/dev-memory-daemon.sh   (from the repo root)
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { ComputerRegistrar } from "../src/server/computers/registration.server";
import {
  PrismaWorkspaceAccess,
  PrismaComputerRegistrationRepository,
} from "../src/server/db/repositories/setup.repositories.server";
import {
  DaemonRuntime,
  startAgentProxy,
  createCodeAgentProvider,
  DaemonConnection,
  defaultCentrifugeWorkspaceClientFactory,
  FileDaemonCredentialStore,
  type CodeAgentProviderFactory,
} from "../../../packages/daemon/index.ts";
import { RUNTIME_PROVIDER } from "../../../packages/coforge-sdk/src/internal/index.ts";
import { readAgentRuntimeCredentialEncryptionKey } from "../src/server/agents/agent-runtime-credentials.server";

const serverHttpUrl = process.env.DEV_SERVER_HTTP_URL ?? "http://127.0.0.1:8788";
const centrifugoWs = process.env.DEV_CENTRIFUGO_WS ?? "ws://127.0.0.1:18000/connection/websocket";
const modelProviderId = process.env.DEV_MEMORY_MODEL_PROVIDER ?? "lenovo-deepseek-v4-flash";
const modelId = process.env.DEV_MEMORY_MODEL ?? "DeepSeek-V4-Flash-0731";
const stateDirectory = process.env.DEV_DAEMON_STATE ?? "/tmp/dev-memory-daemon-state";
process.env.COFORGE_DAEMON_HOME = stateDirectory;
const { configureDaemonLogging } = await import("../../../packages/daemon/src/platform/daemon-logging");
await configureDaemonLogging(stateDirectory);
const workspaceRoot = join(stateDirectory, "workspaces");

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const workspace = await db.workspace.findFirstOrThrow({
  include: { members: { where: { role: "owner" }, take: 1 } },
});
const ownerId = workspace.members[0]!.userId;
console.log(JSON.stringify({ event: "dev_daemon.workspace", slug: workspace.slug }));

const registration = await new ComputerRegistrar({
  workspaceAccess: new PrismaWorkspaceAccess(db),
  registrations: new PrismaComputerRegistrationRepository(db),
}).register(
  {
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceSlug: workspace.slug,
    name: "memory-dev-host",
    displayName: "Memory Dev Host",
    machineId: "memory-dev-host",
    platform: process.platform,
    osVersion: "dev",
    computerVersion: "dev",
    registrationIdempotencyKey: "memory-dev-host-registration",
  },
  { userId: ownerId },
);
console.log(
  JSON.stringify({ event: "dev_daemon.computer_registered", computerId: registration.computerId }),
);

const credentials = new FileDaemonCredentialStore(stateDirectory);
await credentials.save(workspace.id, registration.computerId, registration.daemonApiKey);

let runtime: DaemonRuntime | undefined;
const runtimeApi = (): DaemonRuntime => {
  if (!runtime) throw new Error("daemon runtime not started");
  return runtime;
};
const proxy = startAgentProxy({
  runtime: {
    agentMessage: (context, request, agentApiKey) =>
      runtimeApi().agentMessage(context, request, agentApiKey),
    agentAttachment: (context, attachmentId, agentApiKey) =>
      runtimeApi().agentAttachment(context, attachmentId, agentApiKey),
    inbox: (context, request) => runtimeApi().inbox(context, request),
    issueAgentContext: (agentId, context) => runtimeApi().issueAgentContext(agentId, context),
    agentMemory: (context, request, agentApiKey) =>
      runtimeApi().agentMemory(context, request, agentApiKey),
  },
});

// Probe wrappers: surface the two failure points that are otherwise silent
// retries inside the daemon (session create, launch-config HTTP) as dated
// stderr lines, so a live cycle can be read from the log at a glance.
const { CoforgeProvider: RawCoforgeProvider } = await import("../../../packages/daemon/src/code-agent/pi/provider.ts");
class ProbingCoforgeProvider extends RawCoforgeProvider {
  override async createAgentSession(options: never) {
    try {
      return await super.createAgentSession(options);
    } catch (error) {
      console.error(new Date().toISOString(), "PROBE createAgentSession failed:", error);
      throw error;
    }
  }
}
const providerFactory: CodeAgentProviderFactory = (provider) => {
  const created = createCodeAgentProvider(provider);
  console.log(
    JSON.stringify({ event: "probe_factory", kind: provider, providerCtor: created?.constructor?.name }),
  );
  if (provider === RUNTIME_PROVIDER.COFORGE || created?.constructor?.name === "CoforgeProvider") {
    return new ProbingCoforgeProvider();
  }
  return created;
};

const daemonConfig = {
  workspaceId: workspace.id,
  computerId: registration.computerId,
  workspaceRoot,
  serverHttpUrl,
};

runtime = new DaemonRuntime(
  daemonConfig,
  providerFactory,
  credentials,
  {
    create: () =>
      new (class extends DaemonConnection {
        override async requestAgentLaunchConfig(input: {
          agentId: string;
          workspaceId: string;
          controlEpoch?: number;
          requestId?: string;
          launchId?: string;
        }) {
          try {
            const result = await super.requestAgentLaunchConfig(input as never);
            console.log(JSON.stringify({ event: "probe_launch_config_ok", agentId: input.agentId }));
            return result;
          } catch (error) {
            console.error(
              new Date().toISOString(),
              "PROBE launch-config failed:",
              error instanceof Error ? error.message : error,
              JSON.stringify(
                error instanceof Error ? { status: (error as unknown as { status?: number }).status } : {},
              ),
            );
            throw error;
          }
        }
      })(centrifugoWs, defaultCentrifugeWorkspaceClientFactory),
  },
  proxy,
  {
    runtimes: async () => [{ provider: RUNTIME_PROVIDER.COFORGE, version: "dev", displayName: "CoForge (Pi)" }],
    cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
    catalogs: async () => [],
  },
  stateDirectory,
);

// Host the Memory Agent on this computer and point its fenced session at the
// configured model. The runtime credential follows the web convention
// (AES-GCM associated data `${agentId}\0${providerId}`); the fenced Pi session
// resolves its model catalog from the agent dir's models.json, seeded here
// from the user's global pi config so the provider exists.
const encryptApiKey = async (agentId: string, providerId: string, apiKeyInput: string) => {
  const KEY_ID = "v1";
  const associatedData = new TextEncoder().encode(`${agentId}\0${providerId}`);
  const encryptionKey = readAgentRuntimeCredentialEncryptionKey(process.env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: associatedData },
      await crypto.subtle.importKey("raw", encryptionKey, "AES-GCM", false, ["encrypt"]),
      new TextEncoder().encode(apiKeyInput),
    ),
  );
  return {
    keyId: KEY_ID,
    ciphertext: Buffer.from(encrypted).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    hint: `••••${apiKeyInput.slice(-4)}`,
  };
};
const designation = await db.memoryAgentDesignation.findUniqueOrThrow({
  where: { workspaceId: workspace.id },
});
const apiKeyInput = process.env.DEV_MEMORY_API_KEY;
if (!apiKeyInput) throw new Error("DEV_MEMORY_API_KEY is required (the model provider's API key)");
const builtinDir = join(workspaceRoot, workspace.id, "agents", designation.agentId, ".builtin-runtime");
mkdirSync(builtinDir, { recursive: true });
copyFileSync(`${process.env.HOME}/.pi/agent/models.json`, join(builtinDir, "models.json"));

await db.agent.update({
  where: { id: designation.agentId },
  data: {
    computerId: registration.computerId,
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.COFORGE,
      provider: {
        kind: "coforge",
        providerId: modelProviderId,
        apiKey: await encryptApiKey(designation.agentId, modelProviderId, apiKeyInput),
      },
      model: modelId,
      modelProvider: modelProviderId,
      reasoning: "",
      toolProfile: { kind: "memory-explorer" },
    },
  },
});
console.log(JSON.stringify({ event: "dev_daemon.memory_agent_hosted", agentId: designation.agentId }));

await runtime.start(daemonConfig);
console.log(JSON.stringify({ event: "dev_daemon.started", ws: centrifugoWs, server: serverHttpUrl }));

setInterval(() => {
  console.log(JSON.stringify({ event: "dev_daemon.alive", at: new Date().toISOString() }));
}, 60_000);
