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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { MEMORY_OPERATION_KEY_PATTERN } from "@lrm/coforge-sdk/agent";
import { getCoforgeAgentDir, getCoforgeSessionDir, prepareAgentSessionDirectory } from "./paths";
import { API_KEY_ENV_BY_PROVIDER, configureRuntimeEnvironment } from "./runtime-provider";
import { classifyPiLaunchFailure, PI_MODEL_UNAVAILABLE } from "./launch-error";

/**
 * The Memory Agent's fenced tool profile (ADR 0054-D): the session starts
 * with no tools at all (`noTools: "all"`) and registers exactly the native
 * explorer tools below — four bounded exploration operations plus channel
 * message publishing. No shell, filesystem, or coding tool exists in the
 * profile, and the proxy bearer context never reaches a child process.
 */
export type AgentToolProfile = Readonly<{ kind: "memory-explorer" }>;

const MEMORY_PATH = "/api/agent/v1/memory";
const MESSAGES_PATH = "/api/agent/v1/messages";

type ProxyCall = (path: string, body: Record<string, unknown>) => Promise<string>;

function proxyCaller(environment: Record<string, string>): ProxyCall {
  const proxyUrl = environment.COFORGE_AGENT_PROXY_URL;
  const context = environment.COFORGE_AGENT_CONTEXT;
  return async (path, body) => {
    if (!proxyUrl || !context) throw new Error("CoForge agent proxy is not configured");
    // The proxy URL's base path is the messages route (the CLI's carrier
    // convention — `connectLocal` does the same), so every call REPLACES the
    // pathname wholesale. String concatenation would double it and 404.
    const endpoint = new URL(proxyUrl);
    endpoint.pathname = path;
    endpoint.search = "";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`CoForge agent proxy rejected ${path} (HTTP ${response.status}): ${text}`);
    return text;
  };
}

export function memoryExplorerTools(environment: Record<string, string>): ToolDefinition[] {
  const call = proxyCaller(environment);
  const result = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: undefined,
  });

  const start = defineTool({
    name: "memory_start",
    label: "Start memory exploration",
    description:
      "Start a bounded exploration of the Workspace's team memory and receive the first " +
      "citations. Returns citations as `episode:<uuid>` / `insight:<uuid>` / `skill:<uuid>` ids " +
      "with snippets. start_key is a short idempotency handle you invent — letters, digits, " +
      "hyphens, underscores, no spaces (e.g. 'closing-work-items'); reusing it replays the " +
      "same exploration, so make it unique per question.",
    promptSnippet: "Start a bounded team-memory exploration by query.",
    parameters: Type.Object({
      start_key: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: MEMORY_OPERATION_KEY_PATTERN,
      }),
      query: Type.String({ minLength: 1, maxLength: 500 }),
      max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute(_toolCallId, params) {
      return result(
        await call(MEMORY_PATH, {
          op: "start",
          startKey: params.start_key,
          query: params.query,
          ...(params.max_steps === undefined ? {} : { maxSteps: params.max_steps }),
          ...(params.max_results === undefined ? {} : { maxResults: params.max_results }),
        }),
      );
    },
  });

  const explore = defineTool({
    name: "memory_explore",
    label: "Explore from a citation",
    description:
      "One graph step from a citation this exploration already served, along a relation: " +
      "'similar' (text similarity), 'related' (insight↔episode), or 'collaborators' " +
      "(who worked with whom).",
    promptSnippet: "Walk one memory-graph edge from an already-served citation.",
    parameters: Type.Object({
      session_id: Type.String(),
      operation_id: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: MEMORY_OPERATION_KEY_PATTERN,
      }),
      anchor: Type.String(),
      relation: Type.Optional(
        Type.Union([
          Type.Literal("similar"),
          Type.Literal("related"),
          Type.Literal("collaborators"),
        ]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      return result(
        await call(MEMORY_PATH, {
          op: "explore",
          sessionId: params.session_id,
          operationId: params.operation_id,
          anchor: params.anchor,
          ...(params.relation === undefined ? {} : { relation: params.relation }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        }),
      );
    },
  });

  const redirect = defineTool({
    name: "memory_redirect",
    label: "Redirect the exploration query",
    description: "Re-query the team memory with a new query inside the same exploration session.",
    promptSnippet: "Re-query team memory within the open exploration.",
    parameters: Type.Object({
      session_id: Type.String(),
      operation_id: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: MEMORY_OPERATION_KEY_PATTERN,
      }),
      query: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    async execute(_toolCallId, params) {
      return result(
        await call(MEMORY_PATH, {
          op: "redirect",
          sessionId: params.session_id,
          operationId: params.operation_id,
          query: params.query,
        }),
      );
    },
  });

  const submit = defineTool({
    name: "memory_submit",
    label: "Close the exploration",
    description:
      "Close the exploration session with a cited answer. Every citation id must be one this " +
      "session served; an answer that found something must cite at least one citation.",
    promptSnippet: "Close the exploration with a citation-grounded answer.",
    parameters: Type.Object({
      session_id: Type.String(),
      operation_id: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: MEMORY_OPERATION_KEY_PATTERN,
      }),
      found: Type.Boolean(),
      summary: Type.Optional(Type.String({ maxLength: 2000 })),
      citation_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
    }),
    async execute(_toolCallId, params) {
      return result(
        await call(MEMORY_PATH, {
          op: "close",
          sessionId: params.session_id,
          operationId: params.operation_id,
          found: params.found,
          ...(params.summary === undefined || params.summary.trim() === ""
            ? {}
            : { summary: params.summary }),
          ...(params.citation_ids === undefined ? {} : { citationIds: params.citation_ids }),
        }),
      );
    },
  });

  const offer = defineTool({
    name: "memory_offer",
    label: "Deliver a memory offer",
    description:
      "Deliver cited memory content (an insight or a learned skill) to one teammate agent " +
      "as an advice mention. The server enforces the offer discipline: provenance targets " +
      "must exist, the same target is not redelivered within the cooldown unless the " +
      "teammate explicitly asked, and publication is all-or-none.",
    promptSnippet: "Deliver a cited memory offer to a teammate.",
    parameters: Type.Object({
      operation_key: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: MEMORY_OPERATION_KEY_PATTERN,
      }),
      conversation_id: Type.String({ minLength: 1 }),
      target_agent_id: Type.String({ minLength: 1 }),
      targets: Type.Array(
        Type.Object({
          kind: Type.Union([Type.Literal("insight"), Type.Literal("skill")]),
          id: Type.String({ minLength: 1 }),
        }),
        { minItems: 1, maxItems: 10 },
      ),
      body: Type.String({ minLength: 1, maxLength: 4000 }),
      explicit_ask: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      return result(
        await call(MEMORY_PATH, {
          op: "offer",
          operationKey: params.operation_key,
          conversationId: params.conversation_id,
          targetAgentId: params.target_agent_id,
          targets: params.targets,
          body: params.body,
          ...(params.explicit_ask === undefined ? {} : { explicitAsk: params.explicit_ask }),
        }),
      );
    },
  });

  const send = defineTool({
    name: "send_channel_message",
    label: "Send a channel message",
    description:
      "Publish a message to a channel (or a thread) as this agent. Mentioned teammates are " +
      "woken by the mention. Use this to answer @-mentions and to share memory findings.",
    promptSnippet: "Publish a channel or thread message as this agent.",
    parameters: Type.Object({
      request_id: Type.String({ minLength: 1, maxLength: 128 }),
      target: Type.String({ minLength: 2, maxLength: 80 }),
      body: Type.String({ minLength: 1, maxLength: 12_000 }),
    }),
    async execute(_toolCallId, params) {
      return result(
        await call(MESSAGES_PATH, {
          requestId: params.request_id,
          operation: "send",
          target: params.target,
          content: params.body,
        }),
      );
    },
  });

  // The fenced profile has no shell, but the daemon's inbox notices tell the
  // agent to "run coforge message check" — channel-message bodies arrive only
  // on demand (ADR 0048). These two tools give the fence the same read verbs
  // the CLI gives an ordinary agent, so a pending @mention is reachable.
  const check = defineTool({
    name: "message_check",
    label: "Check pending messages",
    description:
      "List the targets (channels, DMs, threads) with messages pending for you. Pair with " +
      "message_read to fetch a target's bodies.",
    promptSnippet: "List which targets have pending messages.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      return result(
        await call(MESSAGES_PATH, {
          requestId: `message-check-${crypto.randomUUID()}`,
          operation: "check",
        }),
      );
    },
  });

  const read = defineTool({
    name: "message_read",
    label: "Read a target's messages",
    description:
      "Read pending messages from one target (a channel like #general, a DM like @user, or a " +
      "thread). This is how you receive @mentions that arrived while you were not looking.",
    promptSnippet: "Read pending messages from one target.",
    parameters: Type.Object({
      request_id: Type.String({ minLength: 1, maxLength: 128 }),
      target: Type.String({ minLength: 2, maxLength: 120 }),
    }),
    async execute(_toolCallId, params) {
      return result(
        await call(MESSAGES_PATH, {
          requestId: params.request_id,
          operation: "read",
          target: params.target,
        }),
      );
    },
  });

  return [start, explore, redirect, submit, offer, send, check, read];
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
  /** When set, the session starts with zero tools and registers only the
   * profile's native tools (ADR 0054-D's fenced runtime). */
  toolProfile?: AgentToolProfile;
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
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: { systemPromptOverride: () => options.instructions },
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
  const fenced = options.toolProfile?.kind === "memory-explorer";
  const memoryTools = fenced ? memoryExplorerTools(environment) : [];
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model ? { model } : {}),
    ...(options.reasoning ? { thinkingLevel: options.reasoning as never } : {}),
    // The fenced profile replaces the default tool surface entirely: no
    // built-ins, no extensions, only the native explorer tools. The pi SDK's
    // allowlist (`tools`) gates EVERY registry member — custom tools included —
    // so the fence names exactly the native tools; `noTools: "all"` cannot be
    // used here because its empty allowlist would strip the native tools too,
    // leaving `tools: []` on the wire, which model endpoints reject.
    ...(fenced ? { tools: memoryTools.map((tool) => tool.name), customTools: memoryTools } : {}),
    ...(!fenced && options.environment && !extensionDefinesBash
      ? {
          customTools: [
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
          ],
        }
      : {}),
  });
  return {
    ...created,
    services,
    replacedSessionId,
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
