#!/usr/bin/env bun

import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashTool,
  defineTool,
  getAgentDir,
  ModelRuntime,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  agentApiRoutes,
  allocateCausalReadTokens,
  CAUSAL_AGENT_PROTOCOL,
  CAUSAL_CANDIDATE_LIMIT_MAX,
  CAUSAL_OFFER_BUDGET_PER_TRIGGER,
  CAUSAL_READ_BUDGET_PER_TRIGGER,
  CAUSAL_SHARED_TOKEN_BUDGET,
  CAUSAL_TOOL_NAMES,
  CAUSAL_TOOL_PROFILE,
  decodeCausalAgentCommand,
  decodeCausalAgentResponse,
  decodeOpenVikingAgentCommand,
  decodeOpenVikingAgentResponse,
  isMemoryAgentToolProfile,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_NAMES,
  OPENVIKING_TOOL_PROFILE,
  toolsForMemoryFence,
  type CausalAgentCommand,
  type MemoryAgentToolProfile,
  type OpenVikingAgentCommand,
} from "@lrm/coforge-sdk/agent";
import { Type } from "typebox";
import { join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { getCoforgeAgentDir, getCoforgeSessionDir, prepareAgentSessionDirectory } from "./paths";
import { API_KEY_ENV_BY_PROVIDER, configureRuntimeEnvironment } from "./runtime-provider";
import { classifyPiLaunchFailure, PI_MODEL_UNAVAILABLE } from "./launch-error";

const MEMORY_READ_OPS = new Set(["search", "trace", "intervene", "find", "search_context", "read"]);
const MEMORY_TOKEN_OPS = new Set(["search", "trace", "intervene", "search_context"]);

export type MemoryAgentProxy = {
  post(path: string, body: unknown): Promise<unknown>;
};

/** Per-triggering-message shared budget for every Memory Agent fence. */
export class CausalMemoryTurnBudget {
  #fence: MemoryAgentToolProfile;
  #causalReads = 0;
  #offers = 0;
  #tokensRemaining: number = CAUSAL_SHARED_TOKEN_BUDGET;

  constructor(fence: MemoryAgentToolProfile = CAUSAL_TOOL_PROFILE) {
    this.#fence = fence;
  }

  reset(): void {
    this.#causalReads = 0;
    this.#offers = 0;
    this.#tokensRemaining = CAUSAL_SHARED_TOKEN_BUDGET;
  }

  consume(command: CausalAgentCommand | OpenVikingAgentCommand): number | undefined {
    if (MEMORY_READ_OPS.has(command.op)) {
      if (this.#causalReads >= CAUSAL_READ_BUDGET_PER_TRIGGER)
        throw new Error("causal read budget exhausted for this triggering message");
      const limit = "limit" in command ? command.limit : undefined;
      if (limit !== undefined && limit > CAUSAL_CANDIDATE_LIMIT_MAX)
        throw new Error("candidate limit exceeded");
      let allocated: number | undefined;
      if (MEMORY_TOKEN_OPS.has(command.op) && !this.#isStandaloneOpenVikingSearchContext(command)) {
        const requestedTokens = "tokenBudget" in command ? command.tokenBudget : undefined;
        allocated = allocateCausalReadTokens({
          remainingTokens: this.#tokensRemaining,
          requestedTokens,
        });
        this.#tokensRemaining -= allocated;
      }
      this.#causalReads += 1;
      return allocated;
    }
    if (command.op === "offer") {
      if (this.#offers >= CAUSAL_OFFER_BUDGET_PER_TRIGGER)
        throw new Error("causal offer budget exhausted for this triggering message");
      this.#offers += 1;
    }
    return undefined;
  }

  snapshot() {
    return {
      causalReads: this.#causalReads,
      offers: this.#offers,
      tokensUsed: CAUSAL_SHARED_TOKEN_BUDGET - this.#tokensRemaining,
      tokensRemaining: this.#tokensRemaining,
    };
  }

  #isStandaloneOpenVikingSearchContext(command: CausalAgentCommand | OpenVikingAgentCommand) {
    return (
      this.#fence === OPENVIKING_TOOL_PROFILE &&
      command.protocol === OPENVIKING_AGENT_PROTOCOL &&
      command.op === "search_context"
    );
  }
}

type ProxyToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
};

function localProxyUrl(path: string): string {
  const endpoint = Bun.env.COFORGE_AGENT_PROXY_URL;
  const token = Bun.env.COFORGE_AGENT_CONTEXT;
  if (!endpoint || !token) throw new Error("CoForge Agent proxy is not configured");
  return new URL(path, endpoint).toString();
}

async function postLocalProxy(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(localProxyUrl(path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${Bun.env.COFORGE_AGENT_CONTEXT!}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(proxyFailureText(payload, response.status));
  return payload;
}

function proxyFailureText(payload: unknown, status: number): string {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return `CoForge Agent proxy request failed (${status})`;
  const error = payload.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const message = typeof record.message === "string" ? record.message : "";
    const code = typeof record.code === "string" ? record.code : "";
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }
  return `CoForge Agent proxy request failed (${status})`;
}

function toolResult(value: unknown): ProxyToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
}

function defaultMemoryProxy(): MemoryAgentProxy {
  return { post: postLocalProxy };
}

function withAllocatedTokenBudget<T extends { op: string; tokenBudget?: number }>(
  command: T,
  allocated: number | undefined,
): T {
  if (allocated === undefined || (command.op !== "search" && command.op !== "search_context"))
    return command;
  return { ...command, tokenBudget: allocated };
}

/** The only model-callable tools available under a Memory Agent fence. */
export function createMemoryFenceTools(
  profile: MemoryAgentToolProfile,
  budget: CausalMemoryTurnBudget,
  proxy: MemoryAgentProxy = defaultMemoryProxy(),
) {
  const causalTool = <Params extends Record<string, unknown>>(
    name: string,
    label: string,
    description: string,
    op: CausalAgentCommand["op"],
    parameters: Parameters<typeof Type.Object>[0],
  ) =>
    defineTool({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        const command = decodeCausalAgentCommand({
          protocol: CAUSAL_AGENT_PROTOCOL,
          op,
          ...(params as Params),
        });
        const allocated = budget.consume(command);
        const response = await proxy.post(
          agentApiRoutes.proxy.causal.path,
          withAllocatedTokenBudget(command, allocated),
        );
        return toolResult(decodeCausalAgentResponse(command.op, response));
      },
    });

  const openvikingTool = <Params extends Record<string, unknown>>(
    name: string,
    label: string,
    description: string,
    op: OpenVikingAgentCommand["op"],
    parameters: Parameters<typeof Type.Object>[0],
  ) =>
    defineTool({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        const command = decodeOpenVikingAgentCommand({
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op,
          ...(params as Params),
        });
        const allocated = budget.consume(command);
        const response = await proxy.post(
          agentApiRoutes.proxy.openviking.path,
          withAllocatedTokenBudget(command, allocated),
        );
        return toolResult(decodeOpenVikingAgentResponse(command.op, response));
      },
    });

  const messageTool = (
    name: string,
    label: string,
    description: string,
    operation: "check" | "read" | "send",
    parameters: Parameters<typeof Type.Object>[0],
  ) =>
    defineTool({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        const request = {
          requestId: crypto.randomUUID(),
          operation,
          ...(params as { target?: string; content?: string }),
        };
        if (
          operation === "send" &&
          typeof request.target === "string" &&
          !request.target.startsWith("#")
        )
          throw new Error("send_channel_message only sends to a public channel");
        return toolResult(await proxy.post(agentApiRoutes.proxy.messages.path, request));
      },
    });

  const causalByName: Record<string, ReturnType<typeof defineTool>> = {
    [CAUSAL_TOOL_NAMES.search]: causalTool(
      CAUSAL_TOOL_NAMES.search,
      "Causal search",
      "Search cited causal memory for the current public-channel question.",
      "search",
      {
        operationId: Type.String(),
        query: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
      },
    ),
    [CAUSAL_TOOL_NAMES.trace]: causalTool(
      CAUSAL_TOOL_NAMES.trace,
      "Causal trace",
      "Trace cited antecedents and consequences for a causal memory item.",
      "trace",
      { operationId: Type.String(), causalItemId: Type.String() },
    ),
    [CAUSAL_TOOL_NAMES.intervene]: causalTool(
      CAUSAL_TOOL_NAMES.intervene,
      "Causal intervention",
      "Evaluate a bounded causal intervention with cited results.",
      "intervene",
      { operationId: Type.String(), action: Type.String(), context: Type.Optional(Type.String()) },
    ),
    [CAUSAL_TOOL_NAMES.offer]: causalTool(
      CAUSAL_TOOL_NAMES.offer,
      "Publish Memory Offer",
      "Publish one visible, cited Memory Offer. This is the only visible answer to an explicit @memory question. citationRefs are citation ids already returned in this workspace. The server binds the channel and recipient.",
      "offer",
      {
        operationId: Type.String(),
        citationRefs: Type.Array(Type.String(), { minItems: 1 }),
        body: Type.String(),
      },
    ),
    [CAUSAL_TOOL_NAMES.proposeCorrection]: causalTool(
      CAUSAL_TOOL_NAMES.proposeCorrection,
      "Propose causal correction",
      "Submit a cited correction proposal; this cannot invalidate or supersede memory.",
      "propose_correction",
      {
        operationId: Type.String(),
        causalItemId: Type.String(),
        contradictoryCitationRefs: Type.Array(Type.String(), { minItems: 1 }),
        rationale: Type.String(),
      },
    ),
  };

  const openvikingByName: Record<string, ReturnType<typeof defineTool>> = {
    [OPENVIKING_TOOL_NAMES.find]: openvikingTool(
      OPENVIKING_TOOL_NAMES.find,
      "OpenViking find",
      "Find cited OpenViking documents for the current public-channel question.",
      "find",
      {
        operationId: Type.String(),
        query: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        targetUri: Type.Optional(Type.String()),
      },
    ),
    [OPENVIKING_TOOL_NAMES.searchContext]: openvikingTool(
      OPENVIKING_TOOL_NAMES.searchContext,
      "OpenViking search context",
      "Expand hierarchical OpenViking context within the remaining shared token budget.",
      "search_context",
      {
        operationId: Type.String(),
        query: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        targetUri: Type.Optional(Type.String()),
        tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
      },
    ),
    [OPENVIKING_TOOL_NAMES.read]: openvikingTool(
      OPENVIKING_TOOL_NAMES.read,
      "OpenViking read",
      "Read one cited OpenViking document by URI.",
      "read",
      { operationId: Type.String(), uri: Type.String() },
    ),
    [OPENVIKING_TOOL_NAMES.offer]: openvikingTool(
      OPENVIKING_TOOL_NAMES.offer,
      "Publish Memory Offer",
      "Publish one visible, cited Memory Offer. This is the only visible answer to an explicit @memory question. citationRefs are citation ids already returned in this workspace. The server binds the channel and recipient.",
      "offer",
      {
        operationId: Type.String(),
        citationRefs: Type.Array(Type.String(), { minItems: 1 }),
        body: Type.String(),
      },
    ),
  };

  const fenced = toolsForMemoryFence(profile).map((name) => {
    const tool =
      profile === OPENVIKING_TOOL_PROFILE
        ? openvikingByName[name]
        : (causalByName[name] ?? openvikingByName[name]);
    if (!tool) throw new Error(`unsupported Memory Agent tool: ${name}`);
    return tool;
  });

  return [
    ...fenced,
    messageTool(
      "message_check",
      "Check messages",
      "Check pending CoForge messages without shell or network access.",
      "check",
      {},
    ),
    messageTool(
      "message_read",
      "Read messages",
      "Read public-channel messages through the CoForge message route.",
      "read",
      {
        target: Type.String(),
        before: Type.Optional(Type.String()),
        after: Type.Optional(Type.String()),
        around: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
    ),
    messageTool(
      "send_channel_message",
      "Send channel message",
      "Send a visible public-channel message through CoForge. This cannot answer an explicit @memory question; use memory_offer.",
      "send",
      { target: Type.String(), content: Type.String() },
    ),
  ];
}

/** The only model-callable tools available under the causal-memory fence. */
export function createCausalMemoryTools(budget: CausalMemoryTurnBudget, proxy?: MemoryAgentProxy) {
  return createMemoryFenceTools(CAUSAL_TOOL_PROFILE, budget, proxy);
}

export const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  const instructions = Bun.env.COFORGE_AGENT_INSTRUCTIONS;
  if (!instructions?.trim()) throw new Error("CoForge Agent instructions are required");
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: { systemPromptOverride: () => instructions },
  });
  const skillDiagnostics = services.resourceLoader.getSkills().diagnostics;
  if (skillDiagnostics.length > 0) {
    throw new Error(`Cannot start with ${skillDiagnostics.length} skill diagnostic(s)`);
  }
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

export const EVAL_DISABLE_HOST_PI_INJECTION = "COFORGE_EVAL_DISABLE_HOST_PI_INJECTION";

export function evalDisablesHostPiInjection(
  env: { [key: string]: string | undefined } = Bun.env,
): boolean {
  const value = env[EVAL_DISABLE_HOST_PI_INJECTION];
  return value === "1" || value === "true";
}

/** Memory Agent and public-channel eval sessions must not ingest Pi host skills,
 * context files, or extensions. Team memory and skills come from the Memory Agent. */
export function resourceLoaderOptionsForSession(input: {
  instructions: string;
  memoryFence?: boolean;
  disableHostPiInjection?: boolean;
}) {
  const isolate = Boolean(input.memoryFence || input.disableHostPiInjection);
  return {
    systemPromptOverride: () => input.instructions,
    ...(isolate ? { noSkills: true, noContextFiles: true, noExtensions: true } : {}),
  };
}

export async function createSession(options: {
  cwd: string;
  agentId?: string;
  agentDir?: string;
  sessionDir?: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  modelProvider?: string;
  model?: string;
  reasoning?: string;
  apiKey?: string;
  instructions: string;
  environment?: Readonly<Record<string, string>>;
  sessionKind?: "coforge" | "pi";
  toolProfile?: MemoryAgentToolProfile;
}) {
  const cwd = options.cwd;
  const environment = options.environment
    ? { ...options.environment }
    : Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => !!entry[1]),
      );
  const agentDir = options.agentDir ?? getCoforgeAgentDir(cwd);
  const sessionDir = options.sessionDir ?? getCoforgeSessionDir(cwd);
  const sessionKind = options.sessionKind ?? "coforge";
  const expectedSessionDir = join(
    cwd,
    sessionKind === "coforge" ? ".builtin-sessions" : ".pi-sessions",
  );
  if (resolve(sessionDir) !== resolve(expectedSessionDir))
    throw new Error(
      `${sessionKind === "coforge" ? "CoForge" : "Pi"} sessions must use ${sessionKind === "coforge" ? ".builtin-sessions" : ".pi-sessions"}`,
    );
  if (sessionKind === "coforge" && !options.apiKey)
    throw new Error("CoForge runtime provider API key is required");
  const { sessionManager, replacedSessionId } = await sessionManagerFor(
    cwd,
    sessionDir,
    options.sessionId ?? options.agentId,
    options.sessionMode ?? (options.sessionId ? "resume" : "create"),
  );
  const modelRuntime =
    sessionKind === "pi"
      ? await createPiModelRuntime(agentDir, environment ?? {})
      : await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
        });
  if (options.modelProvider && options.apiKey)
    await modelRuntime.setRuntimeApiKey(options.modelProvider, options.apiKey);
  configureRuntimeEnvironment(modelRuntime, environment);
  if (sessionKind === "pi") {
    try {
      await refreshPiModelCatalog(
        modelRuntime,
        environment,
        options.modelProvider ? [options.modelProvider] : undefined,
      );
    } catch (refreshError) {
      // A timed-out/network-failed provider refresh must not surface as an opaque SDK
      // TimeoutError (the old error_code "23"): classify it with launch trace evidence.
      throw classifyPiLaunchFailure(
        modelRuntime,
        options.modelProvider,
        options.model,
        refreshError,
      );
    }
  }
  const memoryFence = isMemoryAgentToolProfile(options.toolProfile)
    ? options.toolProfile
    : undefined;
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: resourceLoaderOptionsForSession({
      instructions: options.instructions,
      memoryFence: Boolean(memoryFence),
      disableHostPiInjection:
        evalDisablesHostPiInjection(options.environment) || evalDisablesHostPiInjection(),
    }),
  });
  if (sessionKind === "coforge") {
    const skillDiagnostics = services.resourceLoader.getSkills().diagnostics;
    if (skillDiagnostics.length > 0)
      throw new Error(`Cannot start with ${skillDiagnostics.length} skill diagnostic(s)`);
  }
  const model =
    options.modelProvider && options.model
      ? modelRuntime.getModel(options.modelProvider, options.model)
      : undefined;
  if (options.model && !model)
    throw classifyPiLaunchFailure(
      modelRuntime,
      options.modelProvider,
      options.model,
      PI_MODEL_UNAVAILABLE,
    );
  const extensionDefinesBash = services.resourceLoader
    .getExtensions()
    .extensions.some((extension) => extension.tools.has("bash"));
  const causalBudget = memoryFence ? new CausalMemoryTurnBudget(memoryFence) : undefined;
  const causalTools =
    memoryFence && causalBudget ? createMemoryFenceTools(memoryFence, causalBudget) : [];
  const customTools = [
    ...(options.environment && !extensionDefinesBash && !causalBudget
      ? [
          createBashTool(cwd, {
            shellPath: services.settingsManager.getShellPath(),
            commandPrefix: services.settingsManager.getShellCommandPrefix(),
            spawnHook: ({ env, ...context }) => {
              const childEnv = { ...env };
              for (const key of [
                "COFORGE_AGENT_CONTEXT",
                "COFORGE_AGENT_PROXY_URL",
                "COFORGE_DAEMON_SOCKET",
                "COFORGE_SUPERVISOR_SOCKET",
                "COFORGE_CURRENT_AGENT_ID",
                "COFORGE_CURRENT_AGENT_NAME",
                "COFORGE_CURRENT_WORKSPACE_ID",
                "COFORGE_CURRENT_WORKSPACE_SLUG",
                "COFORGE_CURRENT_WORKSPACE_NAME",
                "COFORGE_CURRENT_COMPUTER_ID",
                "COFORGE_CURRENT_COMPUTER_NAME",
                "COFORGE_CURRENT_COMPUTER_HOSTNAME",
                "COFORGE_CURRENT_COMPUTER_OS",
                "COFORGE_CURRENT_COMPUTER_VERSION",
                "COFORGE_CURRENT_AGENT_WORKSPACE_PATH",
              ])
                delete childEnv[key];
              Object.assign(childEnv, environment);
              // Pi resolves current metadata before the hook, including absent values.
              for (const key of [
                "PI_SESSION_ID",
                "PI_SESSION_FILE",
                "PI_PROVIDER",
                "PI_MODEL",
                "PI_REASONING_LEVEL",
              ]) {
                if (env[key] === undefined) delete childEnv[key];
                else childEnv[key] = env[key];
              }
              return { ...context, env: childEnv };
            },
          }),
        ]
      : []),
    ...causalTools,
  ];
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model ? { model } : {}),
    ...(options.reasoning ? { thinkingLevel: options.reasoning as never } : {}),
    ...(causalBudget
      ? {
          noTools: "all" as const,
          tools: causalTools.map((tool) => tool.name),
          customTools: causalTools,
        }
      : customTools.length > 0
        ? { customTools }
        : {}),
  });
  return {
    ...created,
    services,
    replacedSessionId,
    resetCausalBudget: causalBudget ? () => causalBudget.reset() : undefined,
    get sessionId() {
      return sessionManager.getSessionId();
    },
    dispose: async () => {
      created.session.clearQueue();
      await created.session.abort();
      await created.session.waitForIdle();
      created.session.dispose();
    },
  };
}

async function sessionManagerFor(
  cwd: string,
  sessionDir: string,
  sessionId: string | undefined,
  mode: "create" | "resume",
) {
  const workspace = await prepareAgentSessionDirectory(cwd, sessionDir);
  if (sessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId))
    throw new Error("Invalid session ID");
  if (sessionId) {
    const path = await findSessionFileForWorkspace(workspace, sessionDir, sessionId);
    if (path) {
      const sessionManager = SessionManager.open(path, sessionDir, workspace);
      if (sessionManager.getSessionId() !== sessionId)
        throw new Error("CoForge session history changed during recovery");
      return { sessionManager, replacedSessionId: undefined };
    }
  }
  const replacedSessionId = mode === "resume" ? sessionId : undefined;
  return {
    sessionManager: SessionManager.create(workspace, sessionDir, {
      id: replacedSessionId ? crypto.randomUUID() : sessionId,
    }),
    replacedSessionId,
  };
}

/** Scoped Pi-format lookup that preserves I/O and malformed-header failures. */
export async function findSessionFile(
  sessionDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const workspace = await prepareAgentSessionDirectory(resolve(sessionDir, ".."), sessionDir);
  return findSessionFileForWorkspace(workspace, sessionDir, sessionId);
}

async function findSessionFileForWorkspace(
  workspace: string,
  sessionDir: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId))
    throw new Error("Invalid session ID");
  // SDK list() hides read failures. Inspect scoped headers directly, including
  // renamed files, so a missing filename is not mistaken for missing history.
  const files = await readdir(sessionDir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  let match: string | undefined;
  for (const name of files.filter((name) => name.endsWith(".jsonl"))) {
    const path = join(sessionDir, name);
    const content = await readFile(path, "utf8");
    const header = JSON.parse(content.split("\n").find((line) => line.trim()) ?? "null");
    if (header?.type !== "session" || typeof header.id !== "string")
      throw new Error("Invalid CoForge session history");
    if (header.cwd !== workspace) continue;
    if (header.id !== sessionId) continue;
    if (match) throw new Error("Ambiguous CoForge session history");
    match = path;
  }
  return match;
}

/** Resolve Pi's exact persisted identity without its CLI prefix/global fallback. */
export async function resolveAgentSessionFile(cwd: string, sessionDir: string, sessionId: string) {
  const workspace = await prepareAgentSessionDirectory(cwd, sessionDir);
  const existing = await findSessionFileForWorkspace(workspace, sessionDir, sessionId);
  if (!existing) throw new Error("Session not found in Agent workspace");
  return existing;
}

export async function discoverModels(cwd: string) {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getCoforgeAgentDir(cwd),
    resourceLoaderOptions: { systemPromptOverride: () => "" },
  });
  return services.modelRuntime.getAvailableSnapshot();
}

export async function discoverPiModels(
  cwd: string,
  options: { agentDir: string; environment?: Readonly<Record<string, string>> },
) {
  const environment = { ...options.environment };
  const modelRuntime = await createPiModelRuntime(options.agentDir, environment);
  configureRuntimeEnvironment(modelRuntime, environment);
  await refreshPiModelCatalog(modelRuntime, environment);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: options.agentDir,
    modelRuntime,
    resourceLoaderOptions: { systemPromptOverride: () => "" },
  });
  return services.modelRuntime.getAvailableSnapshot();
}

async function createPiModelRuntime(
  agentDir: string,
  environment: Readonly<Record<string, string>> = {},
) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  // Resolve native environment credentials through Pi so stored auth retains
  // priority. Snapshot single-key auth per session, without patching process.env.
  // OAuth remains SDK-owned so token refresh is not replaced by a static key.
  for (const [provider, variable] of Object.entries(API_KEY_ENV_BY_PROVIDER)) {
    if (!environment[variable] || modelRuntime.isUsingOAuth(provider)) continue;
    const resolved = await modelRuntime.getAuth(provider, { env: { ...environment } });
    if (resolved?.auth.apiKey) await modelRuntime.setRuntimeApiKey(provider, resolved.auth.apiKey);
  }
  return modelRuntime;
}

async function refreshPiModelCatalog(
  modelRuntime: ModelRuntime,
  environment: Readonly<Record<string, string>>,
  providers?: readonly string[],
) {
  if (Bun.env.PI_OFFLINE !== undefined || environment.PI_OFFLINE !== undefined) return;
  const configuredProviders =
    providers?.filter((provider) => modelRuntime.hasConfiguredAuth(provider)) ??
    modelRuntime
      .getProviders()
      .flatMap((provider) => (modelRuntime.hasConfiguredAuth(provider.id) ? [provider.id] : []));
  if (configuredProviders.length === 0) return;
  // Best-effort and unforced. Without `force`, the SDK's own refresh interval decides when the
  // network is worth hitting, so a slow, offline or hanging network can no longer make every Pi
  // launch wait on (or fail through) a forced catalog fetch. The models already on disk stay
  // usable; a genuinely missing model still fails later, deterministically, at model resolution.
  try {
    await modelRuntime.refresh({
      providers: configuredProviders,
      allowNetwork: true,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // A catalog refresh must never fail the launch.
  }
}

if (import.meta.main) {
  const cwd = process.cwd();
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.inMemory(cwd),
  });
  await runRpcMode(runtime);
}
