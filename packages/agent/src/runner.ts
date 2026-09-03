#!/usr/bin/env bun

import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { seedPiSessionModelRuntime } from "./runtime-provider";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd, agentDir });
  await seedPiSessionModelRuntime(services.modelRuntime);
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

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir: getAgentDir(),
  sessionManager: SessionManager.inMemory(cwd),
});

await runRpcMode(runtime);
