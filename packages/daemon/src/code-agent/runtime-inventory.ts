import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
  type RuntimeMetadata,
} from "@coforge/protocol";
import { agentEnvironment } from "./environment";
import { JsonlProcess } from "./jsonl-process";
import { probeClaudeCodeVersion, resolveClaudeCodeExecutable } from "./claude-code/runtime";
import { COFORGE_DAEMON_VERSION } from "../version";
import { discoverModels } from "@coforge/agent";
import { COFORGE_AGENT_RUNTIME_METADATA } from "./pi/metadata";

export interface ExternalCodeAgentProbe {
  which(name: string): string | undefined;
  spawn(executable: string): {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill?(): void;
  };
  probe?(provider: RuntimeMetadata["provider"], executable: string): Promise<string | undefined>;
  resolve?(
    provider: RuntimeMetadata["provider"],
    name: string,
  ): string | undefined | Promise<string | undefined>;
}

const bunProbe: ExternalCodeAgentProbe = {
  which: (name) => Bun.which(name) ?? undefined,
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
  resolve: async (provider, name) =>
    provider === RUNTIME_PROVIDER.CLAUDE_CODE
      ? await resolveClaudeCodeExecutable((value) => Bun.which(value) ?? undefined)
      : (Bun.which(name) ?? undefined),
};

const externalCodeAgents = [
  { provider: RUNTIME_PROVIDER.PI, executable: "pi" },
  { provider: RUNTIME_PROVIDER.CODEX, executable: "codex" },
  { provider: RUNTIME_PROVIDER.CLAUDE_CODE, executable: "claude" },
] as const;

export async function discoverExternalCodeAgents(
  probe: ExternalCodeAgentProbe = bunProbe,
): Promise<RuntimeMetadata[]> {
  const runtimes: RuntimeMetadata[] = [];
  for (const { provider, executable: name } of externalCodeAgents) {
    const executable = (await probe.resolve?.(provider, name)) ?? probe.which(name);
    if (!executable) continue;
    try {
      const providerProbe =
        provider === RUNTIME_PROVIDER.CODEX ? probe.probe?.(provider, executable) : undefined;
      if (providerProbe !== undefined) {
        const version = await within(providerProbe);
        if (version)
          runtimes.push({
            provider,
            version,
            displayName:
              provider === RUNTIME_PROVIDER.PI
                ? "Pi"
                : provider === RUNTIME_PROVIDER.CODEX
                  ? "Codex"
                  : "Claude Code",
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
      if (exitCode !== 0) continue;
      const version = output.trim().split(/\s+/).pop();
      if (version)
        runtimes.push({
          provider,
          version,
          displayName:
            provider === RUNTIME_PROVIDER.PI
              ? "Pi"
              : provider === RUNTIME_PROVIDER.CODEX
                ? "Codex"
                : "Claude Code",
        });
    } catch {
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
  pi?: readonly string[];
  codex?: readonly string[];
};

export async function discoverCodeAgentInventory(
  options: { probe?: ExternalCodeAgentProbe; commands?: CatalogCommands; cwd?: string } = {},
): Promise<CodeAgentInventory> {
  const probe = options.probe ?? bunProbe;
  const runtimes = [COFORGE_AGENT_RUNTIME_METADATA, ...(await discoverExternalCodeAgents(probe))];
  const cwd = options.cwd ?? process.cwd();
  const commands = options.commands ?? {};
  const discoveries: Array<Promise<CodeAgentModelCatalog | undefined>> = [];
  discoveries.push(discoverCoforgeCatalog(cwd));
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.PI)) {
    const executable = probe.which("pi");
    if (executable)
      discoveries.push(discoverPiCatalogFromProcess(commands.pi ?? [executable], cwd));
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CODEX)) {
    const executable = probe.which("codex");
    if (executable)
      discoveries.push(discoverCodexCatalog(commands.codex ?? [executable, "app-server"], cwd));
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE)) {
    discoveries.push(Promise.resolve(claudeStaticCatalog()));
  }
  const catalogs = (await Promise.all(discoveries)).filter(
    (catalog): catalog is CodeAgentModelCatalog => catalog !== undefined,
  );
  return { runtimes, catalogs };
}

async function discoverCoforgeCatalog(cwd: string): Promise<CodeAgentModelCatalog | undefined> {
  try {
    const snapshot = await discoverModels(cwd);
    const models = Array.isArray(snapshot) ? snapshot : asRecord(snapshot)?.models;
    if (!Array.isArray(models)) throw new Error("CoForge model catalog is unavailable");
    return {
      provider: RUNTIME_PROVIDER.COFORGE,
      models: models.map(piModel).filter(isModel).slice(0, 200),
    };
  } catch {
    return undefined;
  }
}

async function discoverCodexCatalog(
  command: readonly string[],
  cwd: string,
): Promise<CodeAgentModelCatalog | undefined> {
  return withJsonlProcess(command, cwd, async (process) => {
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
    await process.send({ method: "initialized", params: {} });
    const models: CodeAgentModelMetadata[] = [];
    let cursor: string | undefined;
    do {
      const response = await within(
        process.request({
          method: "model/list",
          params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
        }),
      );
      const result = asRecord(response.result);
      if (!Array.isArray(result?.data)) throw new Error("Codex model catalog is unavailable");
      models.push(...result.data.map(codexModel).filter(isModel));
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);
    return { provider: RUNTIME_PROVIDER.CODEX, models };
  });
}

async function withJsonlProcess<T>(
  command: readonly string[],
  cwd: string,
  discover: (process: JsonlProcess) => Promise<T>,
): Promise<T | undefined> {
  const process = new JsonlProcess(command, cwd, agentEnvironment(undefined));
  try {
    return await discover(process);
  } catch {
    return undefined;
  } finally {
    await process.dispose().catch(() => undefined);
  }
}

async function discoverPiCatalogFromProcess(
  command: readonly string[],
  cwd: string,
): Promise<CodeAgentModelCatalog | undefined> {
  return withJsonlProcess(command, cwd, async (process) => {
    const response = await within(process.request({ type: "get_available_models" }));
    const models = asRecord(response.data)?.models;
    if (!Array.isArray(models)) throw new Error("Pi model catalog is unavailable");
    return {
      provider: RUNTIME_PROVIDER.PI,
      models: models.map(piModel).filter(isModel),
    };
  });
}

function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(5_000).then(() => Promise.reject(new Error("model catalog discovery timed out"))),
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
