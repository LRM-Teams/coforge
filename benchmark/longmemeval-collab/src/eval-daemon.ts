import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerRegistrar } from "../../../apps/web/src/server/computers/registration.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "../../../apps/web/src/server/db/repositories/setup.repositories.server";
import { readAgentRuntimeCredentialEncryptionKey } from "../../../apps/web/src/server/agents/agent-runtime-credentials.server";
import {
  DaemonRuntime,
  startAgentProxy,
  createCodeAgentProvider,
  DaemonConnection,
  defaultCentrifugeWorkspaceClientFactory,
  FileDaemonCredentialStore,
  type CodeAgentProviderFactory,
} from "../../../packages/daemon/index.ts";
import {
  decodeAgentStartIntent,
  encodeAgentStartIntent,
  RUNTIME_PROVIDER,
} from "../../../packages/coforge-sdk/src/internal/index.ts";
import { type MemoryAgentToolProfile } from "../../../packages/coforge-sdk/src/agent/memory-tool-fences.ts";
import { EVAL_DISABLE_HOST_PI_INJECTION } from "../../../packages/agent/src/runner.ts";
import { AgentControl } from "../../../apps/web/src/server/agents/agent-control.server";
import { getAgentControlSignal } from "../../../apps/web/src/server/agents/agent-control-signal.server";
import { getAgentRuntimeLock } from "../../../apps/web/src/server/agents/agent-runtime-lock.server";
import { PrismaAgentControlStore } from "../../../apps/web/src/server/db/repositories/agent-control.repositories.server";
import { createAgentSessions } from "../../../apps/web/src/server/db/repositories/agent-session.repositories.server";
import { PrismaDirectConversationRepository } from "../../../apps/web/src/server/db/repositories/direct-conversation.repositories.server";
import { createCentrifugoServerApi } from "../../../apps/web/src/server/centrifugo/server-api.server";
import type { EvalEnv } from "./env";
import type { EvalWorkspace } from "./workspace";

export type EvalDaemon = {
  computerId: string;
  stop: () => Promise<void>;
};

function memoryApiKey(provider: string): string {
  const inline = Bun.env.DEV_MEMORY_API_KEY?.trim();
  if (inline) return inline;
  const modelsPath = `${process.env.HOME}/.pi/agent/models.json`;
  const models = JSON.parse(readFileSync(modelsPath, "utf8")) as {
    providers?: Record<string, { apiKey?: string }>;
  };
  const key = models.providers?.[provider]?.apiKey?.trim();
  if (!key) throw new Error(`Pi provider ${provider} has no apiKey in ~/.pi/agent/models.json`);
  return key;
}

async function encryptApiKey(agentId: string, providerId: string, apiKeyInput: string) {
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
    keyId: "v1",
    ciphertext: Buffer.from(encrypted).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    hint: `••••${apiKeyInput.slice(-4)}`,
  };
}

/** Hosts every workspace agent on one eval computer: the Memory Agent (with the
 * openviking-memory fence attached to its AgentStart intent) and the Task Agent
 * (unfenced — it gets the ordinary channel tools the product gives any agent). */
export async function startEvalDaemon(input: {
  workspace: EvalWorkspace;
  env: EvalEnv;
}): Promise<EvalDaemon> {
  process.env[EVAL_DISABLE_HOST_PI_INJECTION] = "1";
  Bun.env[EVAL_DISABLE_HOST_PI_INJECTION] = "1";
  const webUrl = input.env.webUrl ?? "http://127.0.0.1:8788";
  const centrifugoWs =
    Bun.env.COFORGE_EVAL_CENTRIFUGO_WS ?? "ws://127.0.0.1:18000/connection/websocket";
  if (!process.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)
    throw new Error("missing COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY (source apps/web/.env)");
  if (!process.env.COFORGE_CENTRIFUGO_API_URL || !process.env.COFORGE_CENTRIFUGO_API_KEY)
    throw new Error("missing COFORGE_CENTRIFUGO_API_URL / COFORGE_CENTRIFUGO_API_KEY");
  let probeStatus = 0;
  let probeError = "not started";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const probe = await fetch(webUrl);
      probeStatus = probe.status;
      if (probe.ok || probe.status === 307 || probe.status === 302) break;
      probeError = `status ${probe.status}`;
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  if (probeStatus !== 200 && probeStatus !== 307 && probeStatus !== 302)
    throw new Error(`eval web ${webUrl} returned ${probeStatus || probeError}`);

  const registrar = new ComputerRegistrar({
    workspaceAccess: new PrismaWorkspaceAccess(input.workspace.db),
    registrations: new PrismaComputerRegistrationRepository(input.workspace.db),
  });
  const registration = await registrar.register(
    {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceSlug: input.workspace.slug,
      name: "lme-eval-host",
      displayName: "LME Eval Host",
      machineId: input.workspace.machineId,
      platform: process.platform,
      osVersion: "eval",
      computerVersion: "eval",
      registrationIdempotencyKey: `lme-eval-${input.workspace.workspaceId}`,
    },
    { userId: input.workspace.evalUserId },
  );

  const stateDirectory = join(tmpdir(), `lme-daemon-${input.workspace.workspaceId.slice(0, 8)}`);
  process.env.COFORGE_DAEMON_HOME = stateDirectory;
  const { configureDaemonLogging } = await import(
    "../../../packages/daemon/src/platform/daemon-logging"
  );
  await configureDaemonLogging(stateDirectory);
  const workspaceRoot = join(stateDirectory, "workspaces");
  const credentials = new FileDaemonCredentialStore(stateDirectory);
  await credentials.save(
    input.workspace.workspaceId,
    registration.computerId,
    registration.daemonApiKey,
  );

  const isolatedPiHost = join(stateDirectory, "pi-host");
  mkdirSync(isolatedPiHost, { recursive: true });
  copyFileSync(`${process.env.HOME}/.pi/agent/models.json`, join(isolatedPiHost, "models.json"));
  writeFileSync(join(isolatedPiHost, "settings.json"), `${JSON.stringify({ skills: [] })}\n`, {
    mode: 0o600,
  });
  process.env.PI_CODING_AGENT_DIR = isolatedPiHost;
  for (const agentId of [input.workspace.memoryAgentId, input.workspace.taskAgentId]) {
    const builtinDir = join(
      workspaceRoot,
      input.workspace.workspaceId,
      "agents",
      agentId,
      ".builtin-runtime",
    );
    mkdirSync(builtinDir, { recursive: true });
    copyFileSync(join(isolatedPiHost, "models.json"), join(builtinDir, "models.json"));
    writeFileSync(join(builtinDir, "settings.json"), `${JSON.stringify({ skills: [] })}\n`, {
      mode: 0o600,
    });
  }
  await input.workspace.db.agent.updateMany({
    where: { workspaceId: input.workspace.workspaceId },
    data: { computerId: null },
  });

  let runtime: DaemonRuntime | undefined;
  const runtimeApi = (): DaemonRuntime => {
    if (!runtime) throw new Error("eval daemon runtime not started");
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
      agentOpenviking: (context, request, agentApiKey) =>
        runtimeApi().agentOpenviking(context, request, agentApiKey),
      memoryFence: (agentId) => runtimeApi().memoryFence(agentId),
    },
  });
  const providerFactory: CodeAgentProviderFactory = (provider) => createCodeAgentProvider(provider);
  const daemonConfig = {
    workspaceId: input.workspace.workspaceId,
    computerId: registration.computerId,
    workspaceRoot,
    serverHttpUrl: webUrl,
  };
  runtime = new DaemonRuntime(
    daemonConfig,
    providerFactory,
    credentials,
    {
      create: () => new DaemonConnection(centrifugoWs, defaultCentrifugeWorkspaceClientFactory),
    },
    proxy,
    {
      runtimes: async () => [
        { provider: RUNTIME_PROVIDER.COFORGE, version: "eval", displayName: "CoForge (Pi)" },
      ],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    stateDirectory,
  );
  try {
    await runtime.start(daemonConfig);
  } catch (error) {
    await runtime.stop().catch(() => undefined);
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  const memoryApiKey_ = memoryApiKey(input.env.memoryAgentProvider);
  const taskApiKey = memoryApiKey(input.env.taskAgentProvider);
  await input.workspace.db.agent.update({
    where: { id: input.workspace.memoryAgentId },
    data: {
      computerId: registration.computerId,
      stoppedAt: null,
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.COFORGE,
        provider: {
          kind: "coforge" as const,
          providerId: input.env.memoryAgentProvider,
          apiKey: await encryptApiKey(
            input.workspace.memoryAgentId,
            input.env.memoryAgentProvider,
            memoryApiKey_,
          ),
        },
        model: input.env.memoryAgentModel,
        modelProvider: input.env.memoryAgentProvider,
        reasoning: "",
      },
    },
  });
  await input.workspace.db.agent.update({
    where: { id: input.workspace.taskAgentId },
    data: {
      computerId: registration.computerId,
      stoppedAt: null,
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.COFORGE,
        provider: {
          kind: "coforge" as const,
          providerId: input.env.taskAgentProvider,
          apiKey: await encryptApiKey(
            input.workspace.taskAgentId,
            input.env.taskAgentProvider,
            taskApiKey,
          ),
        },
        model: input.env.taskAgentModel,
        modelProvider: input.env.taskAgentProvider,
        reasoning: "",
      },
    },
  });
  input.workspace.computerId = registration.computerId;
  return {
    computerId: registration.computerId,
    async stop() {
      await runtime?.stop();
    },
  };
}

/** Product Start: server publishes AgentStart over Centrifugo. Message delivery cannot wake an
 * Agent that was never started (`restartConfig` is empty → "Agent is inactive"). */
/** The shared :8788 parser rejects every toolProfile except `{kind:"memory-explorer"}`.
 * Keep the fence off the stored runtimeConfig and attach it only to the Start the eval publishes. */
function centrifugoApiWithFence(fence: MemoryAgentToolProfile | undefined) {
  const api = createCentrifugoServerApi();
  return {
    publishJson: api.publishJson.bind(api),
    async publish(channel: string, data: Uint8Array) {
      if (!fence) return api.publish(channel, data);
      try {
        const intent = decodeAgentStartIntent(data);
        return api.publish(channel, encodeAgentStartIntent({ ...intent, toolProfile: fence }));
      } catch {
        return api.publish(channel, data);
      }
    },
  };
}

export async function startAgent(
  workspace: EvalWorkspace,
  agentId: string,
  fence?: MemoryAgentToolProfile,
): Promise<void> {
  const control = new AgentControl(
    new PrismaAgentControlStore(workspace.db),
    centrifugoApiWithFence(fence),
    getAgentRuntimeLock(),
    { timeoutMs: 90_000, fallbackMs: 1_000 },
    createAgentSessions(workspace.db),
    getAgentControlSignal(),
    new PrismaDirectConversationRepository(workspace.db),
  );
  const result = await control.execute({
    userId: workspace.evalUserId,
    workspaceId: workspace.workspaceId,
    agentId,
    requestId: crypto.randomUUID(),
    action: "start",
  });
  if (result.phase !== "completed") {
    throw new Error(`Agent ${agentId} start ${result.phase}${result.error ? `: ${result.error}` : ""}`);
  }
}
