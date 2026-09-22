import { expect, test } from "bun:test";
import {
  GATEWAY_ROUTE_CLASSIFICATIONS,
  OPENVIKING_CLIENT_IDENTITY_HEADERS,
  classifyGatewayRoute,
  decodeOpenVikingBinding,
  isClientIdentityHeader,
  mapMemoryActor,
  parseCoforgeMemoryActor,
} from "./contract";
import { createFakeOpenVikingProvisioner, createInMemoryOpenVikingBindingStore } from "./stores";

test("unknown OpenViking routes are denied even when a catalog exists", () => {
  expect(GATEWAY_ROUTE_CLASSIFICATIONS).toEqual(["data-plane", "typed-control-only", "denied"]);
  const catalog = [
    { method: "GET", path: "/api/v1/content/read", classification: "data-plane" as const },
    {
      method: "DELETE",
      path: "/api/v1/admin/accounts/{account_id}",
      classification: "typed-control-only" as const,
    },
    { method: "GET", path: "/studio", classification: "denied" as const },
  ];
  expect(classifyGatewayRoute({ method: "GET", path: "/api/v1/content/read" }, catalog)).toBe(
    "data-plane",
  );
  expect(
    classifyGatewayRoute(
      { method: "DELETE", path: "/api/v1/admin/accounts/{account_id}" },
      catalog,
    ),
  ).toBe("typed-control-only");
  expect(classifyGatewayRoute({ method: "GET", path: "/studio" }, catalog)).toBe("denied");
  expect(classifyGatewayRoute({ method: "get", path: "/api/v1/content/read" }, catalog)).toBe(
    "data-plane",
  );
  expect(classifyGatewayRoute({ method: "POST", path: "/api/v1/newly-invented" }, catalog)).toBe(
    "denied",
  );
  expect(classifyGatewayRoute({ method: "GET", path: "/api/v1/content/read" }, [])).toBe("denied");
});

test("client identity and account headers are listed for stripping", () => {
  expect(OPENVIKING_CLIENT_IDENTITY_HEADERS).toEqual([
    "authorization",
    "x-api-key",
    "x-openviking-account",
    "x-openviking-user",
    "x-openviking-role",
    "x-openviking-actor-peer",
  ]);
  expect(isClientIdentityHeader("X-OpenViking-Account")).toBe(true);
  expect(isClientIdentityHeader("content-type")).toBe(false);
});

test("Workspace actors map to distinct OpenViking identities and never to ops-as-reader", () => {
  const binding = { accountId: "acct-ws-a", serviceIdentityId: "svc-projection-ws-a" };
  expect(mapMemoryActor({ actor: { kind: "owner", userId: "u-1" }, binding })).toEqual({
    accountId: "acct-ws-a",
    userId: "user:u-1",
    role: "admin",
    access: "workspace_admin",
  });
  expect(mapMemoryActor({ actor: { kind: "admin", userId: "u-2" }, binding })).toEqual({
    accountId: "acct-ws-a",
    userId: "user:u-2",
    role: "admin",
    access: "workspace_admin",
  });
  expect(mapMemoryActor({ actor: { kind: "member", userId: "u-3" }, binding })).toEqual({
    accountId: "acct-ws-a",
    userId: "user:u-3",
    role: "user",
    access: "own_namespace",
  });
  expect(mapMemoryActor({ actor: { kind: "agent", agentId: "ag-1" }, binding })).toEqual({
    accountId: "acct-ws-a",
    userId: "agent:ag-1",
    role: "user",
    access: "explicit_grant",
  });
  expect(mapMemoryActor({ actor: { kind: "memory_agent", agentId: "mem-1" }, binding })).toEqual({
    accountId: "acct-ws-a",
    userId: "memory-agent:mem-1",
    role: "user",
    access: "readonly_shared",
  });
  expect(mapMemoryActor({ actor: { kind: "projection_worker" }, binding })).toEqual({
    accountId: "acct-ws-a",
    userId: "svc-projection-ws-a",
    role: "service",
    access: "projection_only",
  });
  expect(parseCoforgeMemoryActor({ kind: "ops", userId: "root" })).toBeNull();
});

test("an OpenViking binding stores a credential reference, never plaintext", () => {
  const binding = decodeOpenVikingBinding({
    workspaceId: "ws-a",
    accountId: "acct-ws-a",
    serviceIdentityId: "svc-projection-ws-a",
    credentialRef: "secret:ov-ws-a",
    generation: 1,
  });
  expect(binding).toEqual({
    workspaceId: "ws-a",
    accountId: "acct-ws-a",
    serviceIdentityId: "svc-projection-ws-a",
    credentialRef: "secret:ov-ws-a",
    generation: 1,
  });
  expect(
    decodeOpenVikingBinding({
      workspaceId: "ws-a",
      accountId: "acct-ws-a",
      serviceIdentityId: "svc-projection-ws-a",
      credentialRef: "secret:ov-ws-a",
      credentialPlaintext: "ov-root-key",
      generation: 1,
    }),
  ).toEqual({
    code: "invalid_binding",
    message: "OpenViking binding is invalid",
  });
  expect(
    decodeOpenVikingBinding({
      workspaceId: "ws-a",
      accountId: "acct-ws-a",
      serviceIdentityId: "svc-projection-ws-a",
      apiKey: "ov-root-key",
      generation: 1,
    }),
  ).toEqual({
    code: "invalid_binding",
    message: "OpenViking binding is invalid",
  });
});

test("the binding store fences stale generations and the provisioner never returns secrets", async () => {
  const store = createInMemoryOpenVikingBindingStore();
  const provisioner = createFakeOpenVikingProvisioner();
  const binding = await provisioner.provisionBinding({ workspaceId: "ws-a", generation: 1 });
  expect(binding.credentialRef.startsWith("secret:")).toBe(true);
  expect(JSON.stringify(binding)).not.toContain("plaintext");
  expect(await store.compareAndSet({ workspaceId: "ws-a", expectedGeneration: 0, binding })).toBe(
    "saved",
  );
  const newer = await provisioner.provisionBinding({ workspaceId: "ws-a", generation: 2 });
  expect(
    await store.compareAndSet({ workspaceId: "ws-a", expectedGeneration: 1, binding: newer }),
  ).toBe("saved");
  expect(await store.compareAndSet({ workspaceId: "ws-a", expectedGeneration: 1, binding })).toBe(
    "stale_generation",
  );
  expect(await store.get("ws-a")).toMatchObject({ generation: 2, workspaceId: "ws-a" });
});

test("openviking contracts import no Prisma or transport framework", async () => {
  const sources = ["contract.ts", "index.ts", "stores.ts", "route-policy.ts", "route-catalog.ts"];
  for (const name of sources) {
    const text = await Bun.file(`${import.meta.dir}/${name}`).text();
    expect(text).not.toMatch(/@prisma/);
    expect(text).not.toMatch(/@tanstack/);
    expect(text).not.toMatch(/from ["']prisma/);
    expect(text).not.toMatch(/\bfetch\s*\(/);
  }
});
