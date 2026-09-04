#!/usr/bin/env bun

import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { getCoforgeAgentDir, getCoforgeSessionDir } from "./paths";

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
  modelProvider?: string;
  model?: string;
  reasoning?: string;
  apiKey: string;
  instructions: string;
}) {
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? getCoforgeAgentDir(cwd);
  const sessionDir =
    options.sessionDir ??
    (options.agentId ? getCoforgeSessionDir(cwd) : join(agentDir, "sessions"));
  if (!options.apiKey) throw new Error("CoForge runtime provider API key is required");
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
  const skillDiagnostics = services.resourceLoader.getSkills().diagnostics;
  if (skillDiagnostics.length > 0)
    throw new Error(`Cannot start with ${skillDiagnostics.length} skill diagnostic(s)`);
  const model =
    options.modelProvider && options.model
      ? modelRuntime.getModel(options.modelProvider, options.model)
      : undefined;
  if (options.model && !model) throw new Error("Pi model is unavailable");
  const sessionManager = await sessionManagerFor(cwd, sessionDir, options.sessionId);
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model ? { model } : {}),
    ...(options.reasoning ? { thinkingLevel: options.reasoning as never } : {}),
  });
  return {
    ...created,
    services,
    dispose: async () => created.session.dispose(),
  };
}

async function sessionManagerFor(cwd: string, sessionDir: string, sessionId?: string) {
  if (sessionId) {
    const existing = (await SessionManager.list(cwd, sessionDir)).find(
      (session) => session.id === sessionId,
    );
    if (existing) return SessionManager.open(existing.path, sessionDir, cwd);
  }
  return SessionManager.create(cwd, sessionDir, sessionId ? { id: sessionId } : undefined);
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
