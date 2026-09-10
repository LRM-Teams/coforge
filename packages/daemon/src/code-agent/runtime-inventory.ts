import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
  type RuntimeMetadata,
} from "@coforge/protocol";
import { agentEnvironment } from "./environment";
import { JsonlProcess, JsonlRequestError } from "./jsonl-process";
import { probeClaudeCodeVersion, resolveClaudeCodeExecutable } from "./claude-code/runtime";
import { COFORGE_DAEMON_VERSION } from "../version";
import { codeAgentExecutableSearchPath } from "../platform/code-agent-path";
import {
  COFORGE_PROVIDER_MODELS_GENERATED,
  discoverPiModels,
  getAgentDir,
  PI_SDK_VERSION,
} from "@coforge/agent";
import { COFORGE_AGENT_RUNTIME_METADATA } from "./pi/metadata";
import { discoverKiroCatalog } from "./kiro/catalog";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

export interface ExternalCodeAgentProbe {
  which(name: string, searchPath?: string): string | undefined;
  spawn(executable: string): {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill?(): void;
  };
  probe?(provider: RuntimeMetadata["provider"], executable: string): Promise<string | undefined>;
  resolve?(
    provider: RuntimeMetadata["provider"],
    name: string,
    searchPath?: string,
  ): string | undefined | Promise<string | undefined>;
}

const bunProbe: ExternalCodeAgentProbe = {
  which: (name, searchPath) => Bun.which(name, { PATH: searchPath }) ?? undefined,
  spawn: (executable) =>
    Bun.spawn({ cmd: [executable, "--version"], stdout: "pipe", stderr: "ignore" }),
  probe: async (provider, executable) => {
    if (provider !== RUNTIME_PROVIDER.CODEX) return undefined;
    const child = new JsonlProcess(
      [executable, "app-server"],
      process.cwd(),
      agentEnvironment(undefined),
    );
    try {
      await within(
        child.request({
          method: "initialize",
          params: {
            clientInfo: {
              name: "coforge_daemon",
              title: "CoForge Daemon",
              version: COFORGE_DAEMON_VERSION,
            },
            capabilities: { experimentalApi: false },
          },
        }),
      );
      await child.send({ method: "initialized", params: {} });
    } finally {
      await child.dispose().catch(() => undefined);
    }
    return readVersionWithBun(executable);
  },
  resolve: async (provider, name, searchPath) =>
    provider === RUNTIME_PROVIDER.CLAUDE_CODE
      ? await resolveClaudeCodeExecutable(
          (value) => Bun.which(value, { PATH: searchPath }) ?? undefined,
        )
      : (Bun.which(name, { PATH: searchPath }) ?? undefined),
};

const externalCodeAgents = [
  { provider: RUNTIME_PROVIDER.CODEX, executable: "codex" },
  { provider: RUNTIME_PROVIDER.CLAUDE_CODE, executable: "claude" },
  { provider: RUNTIME_PROVIDER.KIRO, executable: "kiro-cli" },
] as const;

export async function discoverExternalCodeAgents(
  probe: ExternalCodeAgentProbe = bunProbe,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
): Promise<RuntimeMetadata[]> {
  const runtimes: RuntimeMetadata[] = [];
  const searchPath = codeAgentExecutableSearchPath(environment, platform);
  for (const { provider, executable: name } of externalCodeAgents) {
    try {
      const executable =
        (await probe.resolve?.(provider, name, searchPath)) ?? probe.which(name, searchPath);
      if (!executable) {
        logger.info("Code Agent executable was not found", {
          event: "code_agent_runtime:not_found",
          provider,
          executable_name: name,
          outcome: "unavailable",
        });
        continue;
      }
      const providerProbe =
        provider === RUNTIME_PROVIDER.CODEX ? probe.probe?.(provider, executable) : undefined;
      if (providerProbe !== undefined) {
        const version = await within(providerProbe);
        if (version)
          runtimes.push({
            provider,
            version,
            displayName: provider === RUNTIME_PROVIDER.CODEX ? "Codex" : "Claude Code",
          });
        continue;
      }
      if (provider === RUNTIME_PROVIDER.CLAUDE_CODE) {
        const version = await probeClaudeCodeVersion(executable, probe.spawn);
        if (version) runtimes.push({ provider, version, displayName: "Claude Code" });
        continue;
      }
      const process = probe.spawn(executable);
      const { output, exitCode } = await Promise.race([
        Promise.all([new Response(process.stdout).text(), process.exited]).then(
          ([output, exitCode]) => ({ output, exitCode }),
        ),
        Bun.sleep(5_000).then(() => {
          process.kill?.();
          throw new Error("runtime version probe timed out");
        }),
      ]);
      if (exitCode !== 0) {
        logger.warning("Code Agent version probe exited unsuccessfully", {
          event: "code_agent_runtime:probe_failed",
          provider,
          executable_name: name,
          exit_code: exitCode,
          outcome: "unavailable",
        });
        continue;
      }
      const version = output.trim().split(/\s+/).pop();
      if (version)
        runtimes.push({
          provider,
          version,
          displayName: externalRuntimeDisplayName(provider),
        });
    } catch (error) {
      logger.warning("Code Agent runtime probe failed", {
        event: "code_agent_runtime:probe_failed",
        provider,
        executable_name: name,
        error_code: diagnosticErrorCode(error),
        outcome: "unavailable",
      });
      // An executable without a usable version is not available inventory.
    }
  }
  return runtimes;
}

export type CodeAgentInventory = {
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};

type CatalogCommands = {
  codex?: readonly string[];
  kiro?: readonly string[];
};

export async function discoverCodeAgentInventory(
  options: {
    probe?: ExternalCodeAgentProbe;
    commands?: CatalogCommands;
    cwd?: string;
    environment?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
  } = {},
): Promise<CodeAgentInventory> {
  const probe = options.probe ?? bunProbe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const runtimes = [
    COFORGE_AGENT_RUNTIME_METADATA,
    { provider: RUNTIME_PROVIDER.PI, version: PI_SDK_VERSION, displayName: "Pi" },
    ...(await discoverExternalCodeAgents(probe, environment, options.platform)),
  ];
  const cwd = options.cwd ?? process.cwd();
  const commands = options.commands ?? {};
  const discoveries: Array<Promise<CodeAgentModelCatalog | undefined>> = [];
  discoveries.push(Promise.resolve(discoverCoforgeCatalog()));
  discoveries.push(discoverPiCatalog(cwd, environment));
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CODEX)) {
    const executable = probe.which("codex", searchPath);
    if (executable)
      discoveries.push(
        discoverCodexCatalog(commands.codex ?? [executable, "app-server"], cwd, environment),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE)) {
    discoveries.push(Promise.resolve(claudeStaticCatalog()));
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.KIRO)) {
    const executable = probe.which("kiro-cli", searchPath);
    if (executable)
      discoveries.push(
        discoverKiroCatalog(
          commands.kiro ?? [executable, "acp", "--agent-engine", "v3", "--auth-method", "cli"],
          cwd,
          environment,
        ).catch(() => undefined),
      );
  }
  const catalogs = (await Promise.all(discoveries)).filter(
    (catalog): catalog is CodeAgentModelCatalog => catalog !== undefined,
  );
  return { runtimes, catalogs };
}

function discoverCoforgeCatalog(): CodeAgentModelCatalog {
  return {
    provider: RUNTIME_PROVIDER.COFORGE,
    models: COFORGE_PROVIDER_MODELS_GENERATED.map((model) => ({ ...model })),
  };
}

async function discoverCodexCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CodeAgentModelCatalog | undefined> {
  const live = await discoverCodexCatalogFromProcess(command, cwd, environment).catch(
    () => undefined,
  );
  if (live) return live;
  // Match the home inherited by the provider; CODEX_HOME is not in its allowlist.
  const home = environment.HOME ?? environment.USERPROFILE;
  if (!home) return undefined;
  try {
    const cache = asRecord(await Bun.file(join(home, ".codex", "models_cache.json")).json());
    if (!Array.isArray(cache?.models)) return undefined;
    const models = cache.models
      .map((value: unknown) => {
        const entry = asRecord(value);
        if (typeof entry?.slug !== "string" || !entry.slug.trim()) return undefined;
        if (entry.visibility && entry.visibility !== "public" && entry.visibility !== "list")
          return undefined;
        if (entry.supported_in_api === false) return undefined;
        return codexModel({
          model: entry.slug,
          displayName: entry.display_name,
          description: entry.description,
          defaultReasoningEffort: entry.default_reasoning_level,
          supportedReasoningEfforts: Array.isArray(entry.supported_reasoning_levels)
            ? entry.supported_reasoning_levels.map((level: unknown) => ({
                reasoningEffort: asRecord(level)?.effort,
              }))
            : [],
        });
      })
      .filter(isModel);
    if (!models.length) return undefined;
    logger.info("Code Agent model catalog loaded from cache", {
      event: "code_agent_catalog:cache_loaded",
      provider: RUNTIME_PROVIDER.CODEX,
      model_count: models.length,
    });
    return { provider: RUNTIME_PROVIDER.CODEX, models };
  } catch {
    return undefined;
  }
}

async function discoverCodexCatalogFromProcess(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CodeAgentModelCatalog | undefined> {
  return withJsonlProcess(
    RUNTIME_PROVIDER.CODEX,
    command,
    cwd,
    async (process, progress) => {
      progress.stage = "initialize";
      await within(
        process.request({
          method: "initialize",
          params: {
            clientInfo: {
              name: "coforge_daemon",
              title: "CoForge Daemon",
              version: COFORGE_DAEMON_VERSION,
            },
            capabilities: { experimentalApi: false },
          },
        }),
      );
      progress.stage = "initialized";
      await process.send({ method: "initialized", params: {} });
      const models: CodeAgentModelMetadata[] = [];
      let cursor: string | undefined;
      do {
        progress.stage = "model/list";
        const response = await within(
          process.request({
            method: "model/list",
            params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
          }),
        );
        const result = asRecord(response.result);
        progress.stage = "decode_catalog";
        if (!Array.isArray(result?.data))
          throw new CatalogDiscoveryError("Codex model catalog is unavailable");
        models.push(...result.data.map(codexModel).filter(isModel));
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      } while (cursor);
      return { provider: RUNTIME_PROVIDER.CODEX, models };
    },
    environment,
  );
}

type CatalogProgress = {
  stage:
    | "spawn"
    | "initialize"
    | "initialized"
    | "model/list"
    | "get_available_models"
    | "decode_catalog";
};

// Only adapter-authored messages may be persisted; provider output is untrusted.
class CatalogDiscoveryError extends Error {}

async function withJsonlProcess<T>(
  provider: RuntimeMetadata["provider"],
  command: readonly string[],
  cwd: string,
  discover: (process: JsonlProcess, progress: CatalogProgress) => Promise<T>,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<T | undefined> {
  const startedAt = performance.now();
  const discoveryId = crypto.randomUUID();
  const progress: CatalogProgress = { stage: "spawn" };
  let process: JsonlProcess | undefined;
  logger.info("Code Agent model catalog discovery started", {
    event: "code_agent_catalog:discovery_started",
    discovery_id: discoveryId,
    provider,
    stage: progress.stage,
    outcome: "started",
  });
  try {
    process = new JsonlProcess(command, cwd, agentEnvironment(undefined, environment));
    const catalog = await discover(process, progress);
    logger.info("Code Agent model catalog discovery completed", {
      event: "code_agent_catalog:discovery_completed",
      discovery_id: discoveryId,
      provider,
      elapsed_ms: Math.round(performance.now() - startedAt),
      outcome: "ok",
    });
    return catalog;
  } catch (error) {
    logger.warning("Code Agent model catalog discovery failed", {
      event: "code_agent_catalog:discovery_failed",
      provider,
      discovery_id: discoveryId,
      stage: progress.stage,
      elapsed_ms: Math.round(performance.now() - startedAt),
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      provider_error_code:
        error instanceof JsonlRequestError &&
        typeof asRecord(error.responseError)?.code === "number"
          ? asRecord(error.responseError)?.code
          : undefined,
      outcome: "unavailable",
    });
    // Preserve spawn failures reaching the caller; only an established probe
    // may fall back to an unavailable catalog.
    if (!process) throw error;
    return undefined;
  } finally {
    if (process) {
      const cleanupStartedAt = performance.now();
      logger.info("Code Agent model catalog cleanup started", {
        event: "code_agent_catalog:cleanup_started",
        discovery_id: discoveryId,
        provider,
        outcome: "started",
      });
      try {
        await process.dispose();
        logger.info("Code Agent model catalog cleanup completed", {
          event: "code_agent_catalog:cleanup_completed",
          discovery_id: discoveryId,
          provider,
          elapsed_ms: Math.round(performance.now() - cleanupStartedAt),
          outcome: "ok",
        });
      } catch (error) {
        logger.warning("Code Agent model catalog cleanup failed", {
          event: "code_agent_catalog:cleanup_failed",
          discovery_id: discoveryId,
          provider,
          elapsed_ms: Math.round(performance.now() - cleanupStartedAt),
          error_code: diagnosticErrorCode(error),
          error_message: catalogErrorMessage(error),
          outcome: "failed",
        });
      }
    }
  }
}

function catalogErrorMessage(error: unknown): string {
  if (error instanceof CatalogDiscoveryError || error instanceof JsonlRequestError)
    return error.message;
  if (
    error instanceof Error &&
    [
      "code agent process exited unexpectedly",
      "code agent process produced invalid output",
      "code agent process rejected a message",
      "code agent process closed",
      "code agent process is closed",
      "code agent process tree did not exit",
    ].includes(error.message)
  )
    return error.message;
  return "model catalog discovery failed; untrusted error detail omitted";
}

async function discoverPiCatalog(
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CodeAgentModelCatalog | undefined> {
  try {
    const home = environment.HOME ?? environment.USERPROFILE;
    const agentDir =
      environment.PI_CODING_AGENT_DIR ?? (home ? join(home, ".pi", "agent") : getAgentDir());
    const models = await discoverPiModels(cwd, {
      agentDir,
      environment: definedEnvironment(environment),
    });
    return {
      provider: RUNTIME_PROVIDER.PI,
      models: models.map(piModel).filter(isModel),
    };
  } catch {
    return undefined;
  }
}

function definedEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(5_000).then(() =>
      Promise.reject(new CatalogDiscoveryError("model catalog discovery timed out after 5000 ms")),
    ),
  ]);
}

async function readVersionWithBun(executable: string): Promise<string | undefined> {
  const process = Bun.spawn({ cmd: [executable, "--version"], stdout: "pipe", stderr: "ignore" });
  try {
    const { output, exitCode } = await within(
      Promise.all([new Response(process.stdout).text(), process.exited]).then(
        ([output, exitCode]) => ({ output, exitCode }),
      ),
    );
    if (exitCode !== 0) return undefined;
    return output.trim().split(/\s+/).pop() || undefined;
  } finally {
    process.kill();
  }
}

function diagnosticErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.name : "UnknownError";
}

function externalRuntimeDisplayName(provider: RuntimeMetadata["provider"]): string {
  switch (provider) {
    case RUNTIME_PROVIDER.CODEX:
      return "Codex";
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return "Claude Code";
    case RUNTIME_PROVIDER.KIRO:
      return "Kiro";
    default:
      return provider;
  }
}

function piModel(value: unknown): CodeAgentModelMetadata | undefined {
  const model = asRecord(value);
  if (typeof model?.id !== "string" || typeof model.provider !== "string") return undefined;
  const map = asRecord(model.thinkingLevelMap);
  const reasoningEfforts = map
    ? Object.entries(map)
        .filter(([, mapped]) => mapped !== null)
        .map(([level]) => level)
    : model.reasoning === true
      ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      : [];
  return {
    id: model.id,
    displayName: typeof model.name === "string" ? model.name : model.id,
    description: "",
    modelProvider: model.provider,
    reasoningEfforts,
    defaultReasoning: "",
    recommended: false,
  };
}

function codexModel(value: unknown): CodeAgentModelMetadata | undefined {
  const model = asRecord(value);
  if (typeof model?.model !== "string") return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map(asRecord)
        .map((effort) => effort?.reasoningEffort)
        .filter((effort): effort is string => typeof effort === "string")
    : [];
  return {
    id: model.model,
    displayName: typeof model.displayName === "string" ? model.displayName : model.model,
    description: typeof model.description === "string" ? model.description : "",
    modelProvider: "",
    reasoningEfforts: efforts,
    defaultReasoning:
      typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : "",
    recommended: model.isDefault === true,
  };
}

function claudeStaticCatalog(): CodeAgentModelCatalog {
  const fullReasoning = ["low", "medium", "high", "xhigh", "max"];
  const standardReasoning = ["low", "medium", "high", "max"];
  const limitedReasoning = ["low", "medium", "high"];
  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    models: [
      // Maintained fallback catalog for the installed Claude Code runtime.
      claudeStaticModel("opus", "Claude Opus"),
      claudeStaticModel("fable", "Claude Fable"),
      claudeStaticModel("sonnet", "Claude Sonnet"),
      claudeStaticModel("haiku", "Claude Haiku"),
      claudeStaticModel("claude-opus-5", "Claude Opus 5", fullReasoning),
      claudeStaticModel("claude-sonnet-5", "Claude Sonnet 5", fullReasoning),
      claudeStaticModel("claude-sonnet-4-6", "Claude Sonnet 4.6", standardReasoning),
      claudeStaticModel("claude-fable-5", "Claude Fable 5", fullReasoning),
      claudeStaticModel("claude-opus-4-8", "Claude Opus 4.8", fullReasoning),
      claudeStaticModel("claude-opus-4-7", "Claude Opus 4.7", fullReasoning),
      claudeStaticModel("claude-haiku-4-5", "Claude Haiku 4.5", limitedReasoning),
      claudeStaticModel("claude-opus-4-6", "Claude Opus 4.6", standardReasoning),
      claudeStaticModel("claude-sonnet-4-5", "Claude Sonnet 4.5", standardReasoning),
    ],
  };
}

function claudeStaticModel(
  id: string,
  displayName: string,
  reasoningEfforts: string[] = [],
  recommended = false,
): CodeAgentModelMetadata {
  return {
    id,
    displayName,
    description: "",
    modelProvider: "",
    reasoningEfforts: [...reasoningEfforts],
    defaultReasoning: reasoningEfforts.length > 0 ? "medium" : "",
    recommended,
  };
}

function isModel(model: CodeAgentModelMetadata | undefined): model is CodeAgentModelMetadata {
  return model !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
