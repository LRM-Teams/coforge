import { expect, test } from "bun:test";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../workspace-memory/profile";
import {
  createInMemoryWorkspaceMemoryProfileStore,
  saveProfileTransition,
} from "../workspace-memory/stores";
import { lookupAggregatedRoute } from "./catalog/aggregated-catalog";
import { createOpenVikingPolicyGateway } from "./policy-gateway.server";
import { classifyOpenVikingRoute } from "./route-policy";
import { createOpenVikingRuntimeClient, type FetchImpl } from "./runtime-client.server";
import { createInMemoryOpenVikingBindingStore } from "./stores";
import {
  OPENVIKING_TYPED_ACCOUNT_DELETE_ROUTE,
  createOpenVikingTypedAccountDelete,
} from "./typed-account-delete.server";

const ADMIN_IDENTITY = {
  accountId: "root",
  userId: "cleanup-admin",
  role: "admin" as const,
  authorization: "Bearer server-held-admin",
};

function headersFrom(init: RequestInit | undefined): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function channel(fetchImpl: FetchImpl, authorizedOwner = "worker-1") {
  return createOpenVikingTypedAccountDelete({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal:1933",
      fetchImpl,
    }),
    authorizedOwner,
    adminIdentity: ADMIN_IDENTITY,
  });
}

test("account delete is denied on the generic catalog and must use the typed cleanup channel", async () => {
  expect(classifyOpenVikingRoute(OPENVIKING_TYPED_ACCOUNT_DELETE_ROUTE)).toBe("denied");
  expect(
    lookupAggregatedRoute(
      OPENVIKING_TYPED_ACCOUNT_DELETE_ROUTE.method,
      "/api/v1/admin/accounts/acct-ws-a",
    )?.classification,
  ).toBe("denied");
  const source = await Bun.file(
    new URL("./typed-account-delete.server.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/createOpenVikingPolicyGateway|handleOpenVikingGatewayRequest/);
});

test("typed account delete refuses a non-owner without calling OpenViking", async () => {
  let called = false;
  const accounts = channel(async () => {
    called = true;
    return new Response(null, { status: 202 });
  });
  expect(await accounts.deleteAccount({ accountId: "acct-ws-a", owner: "intruder" })).toEqual({
    ok: false,
    sanitizedError: "cleanup owner is not authorized",
  });
  expect(called).toBe(false);
});

test("typed account delete treats 202 and 404 as idempotent success with server-held credentials", async () => {
  const captured: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
  const accounts = channel(async (input, init) => {
    captured.push({
      url: String(input),
      method: init?.method,
      headers: headersFrom(init),
    });
    return new Response(null, { status: captured.length === 1 ? 202 : 404 });
  });
  expect(await accounts.deleteAccount({ accountId: "acct-ws-a", owner: "worker-1" })).toEqual({
    ok: true,
  });
  expect(await accounts.deleteAccount({ accountId: "acct-ws-a", owner: "worker-1" })).toEqual({
    ok: true,
  });
  expect(captured).toEqual([
    {
      url: "http://ov.internal:1933/api/v1/admin/accounts/acct-ws-a",
      method: "DELETE",
      headers: {
        authorization: "Bearer server-held-admin",
        "x-openviking-account": "root",
        "x-openviking-user": "cleanup-admin",
        "x-openviking-role": "admin",
      },
    },
    {
      url: "http://ov.internal:1933/api/v1/admin/accounts/acct-ws-a",
      method: "DELETE",
      headers: {
        authorization: "Bearer server-held-admin",
        "x-openviking-account": "root",
        "x-openviking-user": "cleanup-admin",
        "x-openviking-role": "admin",
      },
    },
  ]);
});

test("typed account delete keeps a remote failure sanitized and never reports success", async () => {
  const accounts = channel(async () => new Response("secret token leaked", { status: 500 }));
  expect(await accounts.deleteAccount({ accountId: "acct-ws-a", owner: "worker-1" })).toEqual({
    ok: false,
    sanitizedError: "openviking account delete failed",
  });
  const unavailable = channel(async () => {
    throw new Error("ECONNREFUSED Bearer ov-secret");
  });
  expect(await unavailable.deleteAccount({ accountId: "acct-ws-a", owner: "worker-1" })).toEqual({
    ok: false,
    sanitizedError: "openviking account delete failed",
  });
  expect(
    await channel(async () => new Response(null, { status: 202 })).deleteAccount({
      accountId: "../admin",
      owner: "worker-1",
    }),
  ).toEqual({ ok: false, sanitizedError: "openviking account delete failed" });
});

test("the policy gateway cannot forward the destructive account delete", async () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  const profiles = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const seed = createDefaultWorkspaceMemoryProfile("ws-a");
  const selected = applyWorkspaceMemoryCommand(
    seed,
    { type: "select_desired", desired: "openviking", at: now },
    { prototypeEnabled: true },
  );
  expect(selected.ok).toBe(true);
  if (!selected.ok) throw new Error(selected.failure.code);
  const ready = applyWorkspaceMemoryCommand(selected.profile, {
    type: "observe_ready",
    generation: selected.profile.generation,
  });
  expect(ready.ok).toBe(true);
  if (!ready.ok) throw new Error(ready.failure.code);
  expect(await saveProfileTransition(profiles, seed, ready.profile)).toBe("saved");
  expect(
    await bindings.compareAndSet({
      workspaceId: "ws-a",
      expectedGeneration: 0,
      binding: {
        workspaceId: "ws-a",
        accountId: "acct-ws-a",
        serviceIdentityId: "svc-ws-a",
        credentialRef: "secret:ov-ws-a",
        generation: ready.profile.generation,
      },
    }),
  ).toBe("saved");

  let forwarded = false;
  const gateway = createOpenVikingPolicyGateway({
    profiles,
    bindings,
    runtime: {
      async request() {
        forwarded = true;
        return {
          ok: true,
          response: {
            status: 202,
            headers: {},
            body: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
          },
        };
      },
    },
    resolveAuthorization: async () => "Bearer server-held-ov-key",
  });
  const denied = await gateway.forward(
    { kind: "owner", userId: "u-1" },
    {
      workspaceId: "ws-a",
      method: "DELETE",
      path: "/api/v1/admin/accounts/acct-ws-a",
    },
  );
  expect(denied.ok).toBe(false);
  expect(forwarded).toBe(false);
});
