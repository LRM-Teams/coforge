import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
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
import { isKiroVersionUnsupported, logKiroVersionUnsupported } from "./kiro/version";
import { discoverCursorCatalog } from "./cursor/catalog";
import { isGrokVersionUnsupported, logGrokVersionUnsupported } from "./grok/version";
import { discoverOpenCodeCatalog } from "./opencode/catalog";
import { isOpenCodeVersionUnsupported, logOpenCodeVersionUnsupported } from "./opencode/version";
import { getLogger } from "@logtape/logtape";
import type { CodeAgentProbe } from "./contract";
import { createCodeAgentProvider } from "./registry";
import { asRecord } from "./json-record";
import { diagnosticErrorCode } from "../platform/diagnostic-error-code";
import {
  CATALOG_CACHE_TTL_MS,
  fileStatCacheKey,
  readInventoryCache,
  writeInventoryCache,
} from "./runtime-inventory-cache";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

export type ExternalCodeAgentProbe = CodeAgentProbe;

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
      await initializeCodex(child);
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
  { provider: RUNTIME_PROVIDER.CURSOR, executable: "cursor-agent" },
  { provider: RUNTIME_PROVIDER.OPENCODE, executable: "opencode" },
  { provider: RUNTIME_PROVIDER.GROK, executable: "grok" },
] as const;

/** The subset of RuntimeProvider backed by an external executable this module probes. */
type ExternalCodeAgentProvider = (typeof externalCodeAgents)[number]["provider"];

/** `externalCodeAgents`, keyed by provider, for callers that already know which one they want. */
const externalCodeAgentExecutable: Record<ExternalCodeAgentProvider, string> = Object.fromEntries(
  externalCodeAgents.map(({ provider, executable }) => [provider, executable]),
) as Record<ExternalCodeAgentProvider, string>;

/** The three probe strategies external providers use to turn a resolved executable into a version. */
async function probeRuntimeVersion(
  provider: ExternalCodeAgentProvider,
  name: string,
  executable: string,
  probe: ExternalCodeAgentProbe,
): Promise<RuntimeMetadata | undefined> {
  const providerProbe =
    provider === RUNTIME_PROVIDER.CODEX ? probe.probe?.(provider, executable) : undefined;
  if (providerProbe !== undefined) {
    const version = await within(providerProbe);
    return version ? { provider, version, displayName: "Codex" } : undefined;
  }
  if (provider === RUNTIME_PROVIDER.CLAUDE_CODE) {
    const version = await probeClaudeCodeVersion(executable, probe.spawn);
    return version ? { provider, version, displayName: "Claude Code" } : undefined;
  }
  const { output, exitCode } = await versionProbeOutput(probe.spawn(executable));
  if (exitCode !== 0) {
    logger.warning("Code Agent version probe exited unsuccessfully", {
      event: "code_agent_runtime:probe_failed",
      provider,
      executable_name: name,
      exit_code: exitCode,
      outcome: "unavailable",
    });
    return undefined;
  }
  // Grok prints `grok <version> (<build hash>)`; the version is the dotted-numeric token, not the
  // last word.
  const version =
    provider === RUNTIME_PROVIDER.GROK
      ? output
          .trim()
          .split(/\s+/)
          .find((token) => /^\d+(\.\d+)*$/.test(token))
      : lastWord(output);
  if (!version) return undefined;
  if (provider === RUNTIME_PROVIDER.KIRO && isKiroVersionUnsupported(version)) {
    logKiroVersionUnsupported(name, version);
    return undefined;
  }
  if (provider === RUNTIME_PROVIDER.OPENCODE && isOpenCodeVersionUnsupported(version)) {
    logOpenCodeVersionUnsupported(name, version);
    return undefined;
  }
  if (provider === RUNTIME_PROVIDER.GROK && isGrokVersionUnsupported(version)) {
    logGrokVersionUnsupported(name, version);
    return undefined;
  }
  return { provider, version, displayName: externalRuntimeDisplayName(provider) };
}

export async function discoverExternalCodeAgents(
  probe: ExternalCodeAgentProbe = bunProbe,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
  requestedProvider?: RuntimeMetadata["provider"],
  cacheDirectory?: string,
): Promise<RuntimeMetadata[]> {
  const runtimes: RuntimeMetadata[] = [];
  const searchPath = codeAgentExecutableSearchPath(environment, platform);
  const cache = cacheDirectory ? await readInventoryCache(cacheDirectory) : undefined;
  let dirty = false;
  for (const { provider, executable: name } of externalCodeAgents) {
    if (requestedProvider && requestedProvider !== provider) continue;
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
      const cacheKey = cache ? await fileStatCacheKey([executable]) : undefined;
      const cached = cacheKey ? cache?.[provider] : undefined;
      if (cacheKey && cached?.key === cacheKey && cached.runtime) {
        // A cache entry written by an older daemon build must be re-validated against the
        // current minimum before it is trusted; the executable itself has not changed, so a
        // too-old cached version would only reproduce the same gate on a live re-probe.
        if (
          provider === RUNTIME_PROVIDER.KIRO &&
          isKiroVersionUnsupported(cached.runtime.version)
        ) {
          logKiroVersionUnsupported(name, cached.runtime.version);
          continue;
        }
        runtimes.push(cached.runtime);
        logger.info("Code Agent runtime probe served from cache", {
          event: "code_agent_runtime:cache_hit",
          provider,
          executable_name: name,
          outcome: "ok",
        });
        continue;
      }
      const runtime = await probeRuntimeVersion(provider, name, executable, probe);
      if (runtime) {
        runtimes.push(runtime);
        if (cache && cacheKey) {
          cache[provider] = { ...cache[provider], key: cacheKey, runtime };
          dirty = true;
        }
      }
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
  if (cache && dirty && cacheDirectory) await writeInventoryCache(cacheDirectory, cache);
  return runtimes;
}

export type CodeAgentInventory = {
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};

type CatalogCommands = {
  codex?: readonly string[];
  kiro?: readonly string[];
  cursor?: readonly string[];
  opencode?: readonly string[];
};

export type CodeAgentDiscoveryOptions = {
  probe?: ExternalCodeAgentProbe;
  commands?: CatalogCommands;
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** The daemon state directory; when set, probe results are cached there across restarts. */
  cacheDirectory?: string;
};

/** A provider whose model catalog is expensive enough (spawns a CLI) to be worth caching. */
const CACHEABLE_CATALOG_PROVIDERS = [
  RUNTIME_PROVIDER.PI,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.CURSOR,
  RUNTIME_PROVIDER.OPENCODE,
] as const;

function piAgentDirectory(environment: Readonly<Record<string, string | undefined>>): string {
  const home = environment.HOME ?? environment.USERPROFILE;
  return environment.PI_CODING_AGENT_DIR ?? (home ? join(home, ".pi", "agent") : getAgentDir());
}

function piCacheKeyPaths(environment: Readonly<Record<string, string | undefined>>): string[] {
  const agentDir = piAgentDirectory(environment);
  return [join(agentDir, "models.json"), join(agentDir, "auth.json")];
}

/** The file(s) whose mtime+size stand in for "has this provider's install changed?". */
async function catalogCacheKeyPaths(
  provider: (typeof CACHEABLE_CATALOG_PROVIDERS)[number],
  probe: ExternalCodeAgentProbe,
  searchPath: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string[] | undefined> {
  if (provider === RUNTIME_PROVIDER.PI) return piCacheKeyPaths(environment);
  const name = externalCodeAgentExecutable[provider];
  const executable = probe.which(name, searchPath);
  return executable ? [executable] : undefined;
}

/**
 * Runtimes-only discovery: cheap PATH lookups plus a version probe per external provider (the
 * only spawning one is Codex, which starts `app-server` for a handshake). This is the fast half
 * of Code Agent discovery and is safe to await before a daemon reports itself ready.
 */
export async function discoverCodeAgentRuntimes(
  options: CodeAgentDiscoveryOptions = {},
): Promise<RuntimeMetadata[]> {
  const probe = options.probe ?? bunProbe;
  const environment = options.environment ?? Bun.env;
  return [
    COFORGE_AGENT_RUNTIME_METADATA,
    { provider: RUNTIME_PROVIDER.PI, version: PI_SDK_VERSION, displayName: "Pi" },
    ...(await discoverExternalCodeAgents(
      probe,
      environment,
      options.platform,
      undefined,
      options.cacheDirectory,
    )),
  ];
}

/**
 * Reads only what the on-disk probe cache already has, without spawning anything. Static catalogs
 * (CoForge, Claude Code) are always included since they cost nothing. Every cacheable provider
 * without a fresh cache entry is left out and flags `needsRefresh`, so the caller knows to run a
 * live `discoverCodeAgentCatalogs` in the background.
 */
export async function loadCachedCodeAgentCatalogs(
  runtimes: RuntimeMetadata[],
  options: CodeAgentDiscoveryOptions = {},
): Promise<{ catalogs: CodeAgentModelCatalog[]; needsRefresh: boolean }> {
  const probe = options.probe ?? bunProbe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const catalogs: CodeAgentModelCatalog[] = [discoverCoforgeCatalog()];
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE))
    catalogs.push(claudeStaticCatalog());
  const cache = options.cacheDirectory
    ? await readInventoryCache(options.cacheDirectory)
    : undefined;
  let needsRefresh = false;
  const providers = CACHEABLE_CATALOG_PROVIDERS.filter(
    (provider) =>
      provider === RUNTIME_PROVIDER.PI || runtimes.some((runtime) => runtime.provider === provider),
  );
  for (const provider of providers) {
    const keyPaths = await catalogCacheKeyPaths(provider, probe, searchPath, environment);
    const key = keyPaths ? await fileStatCacheKey(keyPaths) : undefined;
    const cached = key && cache ? cache[provider] : undefined;
    const fresh = key !== undefined && cached?.key === key && cached.catalog !== undefined;
    if (fresh) catalogs.push(cached.catalog!);
    if (!fresh || Date.now() - (cached?.catalogProbedAt ?? 0) > CATALOG_CACHE_TTL_MS)
      needsRefresh = true;
  }
  return { catalogs, needsRefresh };
}

/**
 * Live catalog discovery: spawns each provider's CLI as needed (Kiro and Pi are the slow ones;
 * Codex's `model/list` is comparatively cheap). Successful cacheable results are written back to
 * the probe cache in a single pass once every discovery has settled, avoiding concurrent
 * read-modify-write races between providers.
 */
export async function discoverCodeAgentCatalogs(
  runtimes: RuntimeMetadata[],
  options: CodeAgentDiscoveryOptions = {},
): Promise<CodeAgentModelCatalog[]> {
  const probe = options.probe ?? bunProbe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const cwd = options.cwd ?? process.cwd();
  const commands = options.commands ?? {};
  type Discovered = {
    provider?: (typeof CACHEABLE_CATALOG_PROVIDERS)[number];
    keyPaths?: string[];
    catalog: CodeAgentModelCatalog | undefined;
  };
  const discoveries: Array<Promise<Discovered>> = [];
  discoveries.push(Promise.resolve({ catalog: discoverCoforgeCatalog() }));
  discoveries.push(
    discoverPiCatalog(cwd, environment).then((catalog) => ({
      provider: RUNTIME_PROVIDER.PI,
      keyPaths: piCacheKeyPaths(environment),
      catalog,
    })),
  );
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CODEX)) {
    const executable = probe.which(externalCodeAgentExecutable[RUNTIME_PROVIDER.CODEX], searchPath);
    if (executable)
      discoveries.push(
        discoverCodexCatalog(commands.codex ?? [executable, "app-server"], cwd, environment).then(
          (catalog) => ({ provider: RUNTIME_PROVIDER.CODEX, keyPaths: [executable], catalog }),
        ),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE)) {
    discoveries.push(Promise.resolve({ catalog: claudeStaticCatalog() }));
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.KIRO)) {
    const executable = probe.which(externalCodeAgentExecutable[RUNTIME_PROVIDER.KIRO], searchPath);
    if (executable)
      discoveries.push(
        discoverKiroCatalog(
          commands.kiro ?? [executable, "acp", "--agent-engine", "v3", "--auth-method", "cli"],
          cwd,
          environment,
        )
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.KIRO,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CURSOR)) {
    const executable = probe.which(
      externalCodeAgentExecutable[RUNTIME_PROVIDER.CURSOR],
      searchPath,
    );
    if (executable)
      discoveries.push(
        discoverCursorCatalog(commands.cursor ?? [executable, "models"], cwd, environment)
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.CURSOR,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  // OpenCode was the one cacheable provider this refresh had no branch for, so its catalog was
  // never probed: an Agent whose runtime is OpenCode saw an empty model list in the UI even
  // though `opencode models` lists models fine on the CLI.
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.OPENCODE)) {
    const executable = probe.which(
      externalCodeAgentExecutable[RUNTIME_PROVIDER.OPENCODE],
      searchPath,
    );
    if (executable)
      discoveries.push(
        discoverOpenCodeCatalog(commands.opencode ?? [executable, "models"], cwd, environment)
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.OPENCODE,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  const results = await Promise.all(discoveries);
  if (options.cacheDirectory) {
    const cacheDirectory = options.cacheDirectory;
    const cache = await readInventoryCache(cacheDirectory);
    let dirty = false;
    for (const { provider, keyPaths, catalog } of results) {
      if (!provider || !keyPaths || !catalog) continue;
      const key = await fileStatCacheKey(keyPaths);
      if (!key) continue;
      cache[provider] = { ...cache[provider], key, catalog, catalogProbedAt: Date.now() };
      dirty = true;
    }
    if (dirty) await writeInventoryCache(cacheDirectory, cache);
  }
  return results.flatMap(({ catalog }) => (catalog ? [catalog] : []));
}

export async function discoverCodeAgentInventory(
  options: CodeAgentDiscoveryOptions = {},
): Promise<CodeAgentInventory> {
  if (!options.probe && !options.commands) {
    const providers = Object.values(RUNTIME_PROVIDER).map(createCodeAgentProvider);
    const discoveries = providers.map(async (provider) => {
      const runtime = await provider.discoverRuntime?.({
        cwd: options.cwd,
        environment: options.environment,
        platform: options.platform,
      });
      const catalog = runtime
        ? await provider.discoverModelCatalog?.({
            cwd: options.cwd,
            environment: options.environment,
            platform: options.platform,
          })
        : undefined;
      return { runtime, catalog };
    });
    const discovered = await Promise.all(discoveries);
    return {
      runtimes: discovered.flatMap(({ runtime }) => (runtime ? [runtime] : [])),
      catalogs: discovered.flatMap(({ catalog }) => (catalog ? [catalog] : [])),
    };
  }
  const runtimes = await discoverCodeAgentRuntimes(options);
  const catalogs = await discoverCodeAgentCatalogs(runtimes, options);
  return { runtimes, catalogs };
}

export function discoverCoforgeCatalog(): CodeAgentModelCatalog {
  return {
    provider: RUNTIME_PROVIDER.COFORGE,
    models: COFORGE_PROVIDER_MODELS_GENERATED.map((model) => ({ ...model })),
  };
}

export async function discoverCodexCatalog(
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
      await initializeCodex(process, progress);
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

/** Completes the Codex app-server handshake; a bounded wait guards the initialize reply. */
async function initializeCodex(process: JsonlProcess, progress?: CatalogProgress): Promise<void> {
  if (progress) progress.stage = "initialize";
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
  if (progress) progress.stage = "initialized";
  await process.send({ method: "initialized", params: {} });
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

export async function discoverPiCatalog(
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CodeAgentModelCatalog | undefined> {
  try {
    const agentDir = piAgentDirectory(environment);
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

/** Collects a `--version` child's output, killing it if it outlives the probe budget. */
export async function versionProbeOutput(
  process: ReturnType<CodeAgentProbe["spawn"]>,
): Promise<{ output: string; exitCode: number }> {
  return Promise.race([
    Promise.all([new Response(process.stdout).text(), process.exited]).then(
      ([output, exitCode]) => ({ output, exitCode }),
    ),
    Bun.sleep(5_000).then(() => {
      process.kill?.();
      throw new Error("runtime version probe timed out");
    }),
  ]);
}

function lastWord(output: string): string | undefined {
  return output.trim().split(/\s+/).pop() || undefined;
}

async function readVersionWithBun(executable: string): Promise<string | undefined> {
  const process = Bun.spawn({ cmd: [executable, "--version"], stdout: "pipe", stderr: "ignore" });
  try {
    const { output, exitCode } = await versionProbeOutput(process);
    return exitCode === 0 ? lastWord(output) : undefined;
  } finally {
    process.kill();
  }
}

function externalRuntimeDisplayName(provider: ExternalCodeAgentProvider): string {
  switch (provider) {
    case RUNTIME_PROVIDER.CODEX:
      return "Codex";
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return "Claude Code";
    case RUNTIME_PROVIDER.KIRO:
      return "Kiro";
    case RUNTIME_PROVIDER.CURSOR:
      return "Cursor CLI";
    case RUNTIME_PROVIDER.OPENCODE:
      return "OpenCode";
    case RUNTIME_PROVIDER.GROK:
      return "Grok Build";
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled external Code Agent provider: ${unreachable}`);
    }
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

export function claudeStaticCatalog(): CodeAgentModelCatalog {
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
