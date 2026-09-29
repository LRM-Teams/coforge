/**
 * Memory Agent OpenViking reads. Catalog paths stay in this module;
 * callers invoke named operations and never assemble /api/v1/ literals.
 */

import { lookupAggregatedRoute } from "./catalog/aggregated-catalog";

export const MEMORY_AGENT_READ_OPERATIONS = ["find", "search_context", "read"] as const;
export type MemoryAgentReadOperation = (typeof MEMORY_AGENT_READ_OPERATIONS)[number];

export class MemoryAgentMutationError extends Error {
  constructor() {
    super("Memory Agent cannot mutate OpenViking memory");
    this.name = "MemoryAgentMutationError";
  }
}

export type OpenVikingMemoryReadInvocation = {
  workspaceId: string;
  agentId: string;
  operation: MemoryAgentReadOperation;
  query?: Record<string, string>;
  body?: unknown;
};

export type OpenVikingMemoryReadClient = {
  invoke(request: OpenVikingMemoryReadInvocation): Promise<unknown>;
};

export type OpenVikingCatalogReadTransport = {
  forward(request: {
    workspaceId: string;
    agentId: string;
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  }): Promise<unknown>;
};

const MEMORY_AGENT_READ_ROUTES = {
  find: requireMemoryReadRoute("POST", "/api/v1/search/find"),
  search_context: requireMemoryReadRoute("POST", "/api/v1/search/search"),
  read: requireMemoryReadRoute("GET", "/api/v1/content/read"),
} as const;

function requireMemoryReadRoute(method: string, path: string): { method: string; path: string } {
  const route = lookupAggregatedRoute(method, path);
  if (!route || route.classification === "denied") {
    throw new Error(`Memory Agent read route is not classified: ${method} ${path}`);
  }
  return { method: route.method, path: route.path };
}

export function memoryAgentReadRoute(operation: MemoryAgentReadOperation): {
  method: string;
  path: string;
} {
  return MEMORY_AGENT_READ_ROUTES[operation];
}

export function createCatalogOpenVikingMemoryReadClient(
  transport: OpenVikingCatalogReadTransport,
): OpenVikingMemoryReadClient {
  return {
    async invoke(request) {
      if (!isMemoryAgentReadOperation(request.operation)) throw new MemoryAgentMutationError();
      const route = memoryAgentReadRoute(request.operation);
      return transport.forward({
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        method: route.method,
        path: route.path,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    },
  };
}

function isMemoryAgentReadOperation(value: unknown): value is MemoryAgentReadOperation {
  return (
    typeof value === "string" && (MEMORY_AGENT_READ_OPERATIONS as readonly string[]).includes(value)
  );
}
