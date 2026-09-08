#!/usr/bin/env bun

import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashTool,
  getAgentDir,
  ModelRuntime,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { getCoforgeAgentDir, getCoforgeSessionDir } from "./paths";
import { withRuntimeEnvironment } from "./runtime-provider";

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
  apiKey: string;
  instructions: string;
  environment?: Readonly<Record<string, string>>;
}) {
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? getCoforgeAgentDir(cwd);
  const sessionDir =
    options.sessionDir ??
    (options.agentId ? getCoforgeSessionDir(cwd) : join(agentDir, "sessions"));
  if (!options.apiKey) throw new Error("CoForge runtime provider API key is required");
  const { modelRuntime, services } = await withRuntimeEnvironment(
    options.environment ?? {},
    async () => {
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      if (options.modelProvider)
        await modelRuntime.setRuntimeApiKey(options.modelProvider, options.apiKey);
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        resourceLoaderOptions: { systemPromptOverride: () => options.instructions },
      });
      return { modelRuntime, services };
    },
  );
  const skillDiagnostics = services.resourceLoader.getSkills().diagnostics;
  if (skillDiagnostics.length > 0)
    throw new Error(`Cannot start with ${skillDiagnostics.length} skill diagnostic(s)`);
  const model =
    options.modelProvider && options.model
      ? modelRuntime.getModel(options.modelProvider, options.model)
      : undefined;
  if (options.model && !model) throw new Error("Pi model is unavailable");
  const { sessionManager, replacedSessionId } = await sessionManagerFor(
    cwd,
    sessionDir,
    options.sessionId ?? options.agentId,
    options.sessionMode ?? (options.sessionId ? "resume" : "create"),
  );
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model ? { model } : {}),
    ...(options.reasoning ? { thinkingLevel: options.reasoning as never } : {}),
    ...(options.environment
      ? {
          customTools: [
            createBashTool(cwd, {
              spawnHook: ({ env, ...context }) => ({
                ...context,
                env: { ...env, ...options.environment },
              }),
            }),
          ],
        }
      : {}),
  });
  return {
    ...created,
    services,
    replacedSessionId,
    dispose: async () => created.session.dispose(),
  };
}

async function sessionManagerFor(
  cwd: string,
  sessionDir: string,
  sessionId: string | undefined,
  mode: "create" | "resume",
) {
  if (sessionId) {
    const path = await findSessionFile(sessionDir, sessionId);
    if (path) {
      const sessionManager = SessionManager.open(path, sessionDir, cwd);
      if (sessionManager.getSessionId() !== sessionId)
        throw new Error("CoForge session history changed during recovery");
      return { sessionManager, replacedSessionId: undefined };
    }
  }
  const replacedSessionId = mode === "resume" ? sessionId : undefined;
  return {
    sessionManager: SessionManager.create(cwd, sessionDir, {
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
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId))
    throw new Error("Invalid CoForge session ID");
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
    if (header.id !== sessionId) continue;
    if (match) throw new Error("Ambiguous CoForge session history");
    match = path;
  }
  return match;
}

export async function discoverModels(cwd: string) {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getCoforgeAgentDir(cwd),
    resourceLoaderOptions: { systemPromptOverride: () => "" },
  });
  return services.modelRuntime.getAvailableSnapshot();
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
