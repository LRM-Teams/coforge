export const GATEWAY_ROUTE_CLASSIFICATIONS = [
  "data-plane",
  "typed-control-only",
  "denied",
] as const;
export type GatewayRouteClassification = (typeof GATEWAY_ROUTE_CLASSIFICATIONS)[number];

export type GatewayRoutePolicy = {
  method: string;
  path: string;
  classification: GatewayRouteClassification;
};

export function classifyGatewayRoute(
  route: { method: string; path: string },
  catalog: readonly GatewayRoutePolicy[],
): GatewayRouteClassification {
  const method = route.method.toUpperCase();
  const match = catalog.find(
    (entry) => entry.method.toUpperCase() === method && entry.path === route.path,
  );
  return match?.classification ?? "denied";
}

export const OPENVIKING_CLIENT_IDENTITY_HEADERS = [
  "authorization",
  "x-api-key",
  "x-openviking-account",
  "x-openviking-user",
  "x-openviking-role",
  "x-openviking-actor-peer",
] as const;

export function isClientIdentityHeader(name: string): boolean {
  return (OPENVIKING_CLIENT_IDENTITY_HEADERS as readonly string[]).includes(name.toLowerCase());
}

export type CoforgeMemoryActor =
  | { kind: "owner"; userId: string }
  | { kind: "admin"; userId: string }
  | { kind: "member"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "memory_agent"; agentId: string }
  | { kind: "projection_worker" };

export type OpenVikingAccess =
  | "workspace_admin"
  | "own_namespace"
  | "explicit_grant"
  | "readonly_shared"
  | "projection_only";

export type OpenVikingMappedIdentity = {
  accountId: string;
  userId: string;
  role: "admin" | "user" | "service";
  access: OpenVikingAccess;
};

export function parseCoforgeMemoryActor(value: unknown): CoforgeMemoryActor | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  switch (input.kind) {
    case "owner":
    case "admin":
    case "member":
      return typeof input.userId === "string" ? { kind: input.kind, userId: input.userId } : null;
    case "agent":
    case "memory_agent":
      return typeof input.agentId === "string"
        ? { kind: input.kind, agentId: input.agentId }
        : null;
    case "projection_worker":
      return { kind: "projection_worker" };
    default:
      return null;
  }
}

export function mapMemoryActor(input: {
  actor: CoforgeMemoryActor;
  binding: { accountId: string; serviceIdentityId: string };
}): OpenVikingMappedIdentity {
  const { accountId, serviceIdentityId } = input.binding;
  switch (input.actor.kind) {
    case "owner":
    case "admin":
      return {
        accountId,
        userId: `user:${input.actor.userId}`,
        role: "admin",
        access: "workspace_admin",
      };
    case "member":
      return {
        accountId,
        userId: `user:${input.actor.userId}`,
        role: "user",
        access: "own_namespace",
      };
    case "agent":
      return {
        accountId,
        userId: `agent:${input.actor.agentId}`,
        role: "user",
        access: "explicit_grant",
      };
    case "memory_agent":
      return {
        accountId,
        userId: `memory-agent:${input.actor.agentId}`,
        role: "user",
        access: "readonly_shared",
      };
    case "projection_worker":
      return {
        accountId,
        userId: serviceIdentityId,
        role: "service",
        access: "projection_only",
      };
  }
}

export type OpenVikingBinding = {
  workspaceId: string;
  accountId: string;
  serviceIdentityId: string;
  credentialRef: string;
  generation: number;
};

export type OpenVikingBindingFailure = {
  code: "invalid_binding";
  message: string;
};

const FORBIDDEN_BINDING_KEYS = ["credentialPlaintext", "apiKey", "plaintext", "token"] as const;

export function decodeOpenVikingBinding(
  value: unknown,
): OpenVikingBinding | OpenVikingBindingFailure {
  const invalid: OpenVikingBindingFailure = {
    code: "invalid_binding",
    message: "OpenViking binding is invalid",
  };
  if (!value || typeof value !== "object") return invalid;
  const input = value as Record<string, unknown>;
  if (FORBIDDEN_BINDING_KEYS.some((key) => key in input)) return invalid;
  if (
    typeof input.workspaceId !== "string" ||
    typeof input.accountId !== "string" ||
    typeof input.serviceIdentityId !== "string" ||
    typeof input.credentialRef !== "string" ||
    !input.credentialRef.startsWith("secret:") ||
    !Number.isInteger(input.generation) ||
    (input.generation as number) < 0
  ) {
    return invalid;
  }
  return {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    serviceIdentityId: input.serviceIdentityId,
    credentialRef: input.credentialRef,
    generation: input.generation as number,
  };
}
