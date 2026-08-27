import { cpus, totalmem } from "node:os";

const TWO_GIB = 2 * 1024 ** 3;

/** The host resources used by the default Agent capacity policy. */
export type AgentResourceSnapshot = Readonly<{
  cpuCores: number;
  memoryBytes: number;
}>;

/** Provider-neutral policy for choosing the daemon's Agent capacity. */
export interface AgentCapacityPolicy {
  resolve(resources: AgentResourceSnapshot): number;
}

export const computedAgentCapacityPolicy: AgentCapacityPolicy = {
  resolve(resources) {
    validateResources(resources);
    return Math.max(1, Math.min(resources.cpuCores, Math.floor(resources.memoryBytes / TWO_GIB)));
  },
};

export type ResolveAgentCapacityOptions = Readonly<{
  configuredCapacity?: number;
  environment?: Readonly<Record<string, string | undefined>>;
  resources?: AgentResourceSnapshot;
  policy?: AgentCapacityPolicy;
}>;

/** Resolve explicit configuration, then COFORGE_AGENT_CAPACITY, then host resources. */
export function resolveAgentCapacity(options: ResolveAgentCapacityOptions = {}): number {
  if (options.configuredCapacity !== undefined) {
    return validateCapacity(options.configuredCapacity, "configured Agent capacity");
  }

  const environment = options.environment ?? process.env;
  const configuredByEnvironment = environment.COFORGE_AGENT_CAPACITY;
  if (configuredByEnvironment !== undefined) {
    if (!/^\d+$/.test(configuredByEnvironment)) {
      throw new RangeError("COFORGE_AGENT_CAPACITY must be a positive integer");
    }
    return validateCapacity(Number(configuredByEnvironment), "COFORGE_AGENT_CAPACITY");
  }

  const resources = options.resources ?? readDefaultAgentResources();
  return (options.policy ?? computedAgentCapacityPolicy).resolve(resources);
}

/** Bun supports this Node-compatible API for host CPU and memory discovery. */
export function readDefaultAgentResources(): AgentResourceSnapshot {
  return { cpuCores: cpus().length, memoryBytes: totalmem() };
}

function validateCapacity(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function validateResources(resources: AgentResourceSnapshot): void {
  if (!Number.isSafeInteger(resources.cpuCores) || resources.cpuCores < 1) {
    throw new RangeError("Agent resource cpuCores must be a positive integer");
  }
  if (!Number.isSafeInteger(resources.memoryBytes) || resources.memoryBytes < 1) {
    throw new RangeError("Agent resource memoryBytes must be a positive integer");
  }
}
