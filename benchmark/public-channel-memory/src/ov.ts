import { createOpenVikingTypedAccountDelete } from "../../../apps/web/src/server/openviking/typed-account-delete.server";
import {
  createOpenVikingRuntimeClient,
  type OpenVikingRuntimeClient,
  type OpenVikingRuntimeResult,
} from "../../../apps/web/src/server/openviking/runtime-client.server";
import { DEFAULT_OPENVIKING_TRANSPORT_LIMITS } from "../../../apps/web/src/server/openviking/route-policy";
import type { ServerOpenVikingIdentity } from "../../../apps/web/src/server/openviking/route-policy";

const LIMITS = {
  ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  maxRequestBytes: 8_388_608,
  timeoutMs: 120_000,
} as const;

export type OvUsers = {
  adminUserId: string;
  userId: string;
  adminKey: string;
  userKey: string;
};

export function createEvalRuntime(baseUrl: string): OpenVikingRuntimeClient {
  return createOpenVikingRuntimeClient({ baseUrl, limits: LIMITS });
}

export function rootIdentity(rootKey: string): ServerOpenVikingIdentity {
  return {
    accountId: "root",
    userId: "eval-root",
    role: "admin",
    authorization: `Bearer ${rootKey}`,
  };
}

export function userIdentity(
  accountId: string,
  userId: string,
  userKey: string,
  role: "admin" | "user" = "user",
): ServerOpenVikingIdentity {
  return { accountId, userId, role, authorization: `Bearer ${userKey}` };
}

export async function readSecretRootKey(path: string): Promise<string> {
  const parsed = JSON.parse(await Bun.file(path).text()) as { server?: { root_api_key?: unknown } };
  const key = parsed.server?.root_api_key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("openviking prototype conf is missing server.root_api_key");
  }
  return key;
}

async function readRuntimeJson(result: OpenVikingRuntimeResult): Promise<{
  status: number;
  json: Record<string, unknown> | null;
}> {
  if (!result.ok) throw new Error(`openviking transport ${result.failure.code}`);
  const text = await new Response(result.response.body).text();
  let json: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text) as unknown;
      json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
  }
  return { status: result.response.status, json };
}

function resultField(json: Record<string, unknown> | null): Record<string, unknown> {
  const result = json?.result;
  return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
}

export async function provisionDisposableAccount(
  runtime: OpenVikingRuntimeClient,
  root: ServerOpenVikingIdentity,
  accountId: string,
): Promise<OvUsers> {
  const created = await readRuntimeJson(
    await runtime.request({
      method: "POST",
      path: "/api/v1/admin/accounts",
      identity: root,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: accountId, admin_user_id: "eval-admin" }),
    }),
  );
  if (created.status >= 300) throw new Error(`typed account create failed status=${created.status}`);
  const adminKey = resultField(created.json).user_key;
  if (typeof adminKey !== "string" || adminKey.length === 0) {
    throw new Error("typed account create did not return a user key");
  }
  const registered = await readRuntimeJson(
    await runtime.request({
      method: "POST",
      path: `/api/v1/admin/accounts/${accountId}/users`,
      identity: root,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "eval-user", role: "user" }),
    }),
  );
  if (registered.status >= 300) throw new Error(`typed user create failed status=${registered.status}`);
  const userKey = resultField(registered.json).user_key;
  if (typeof userKey !== "string" || userKey.length === 0) {
    throw new Error("typed user create did not return a user key");
  }
  return { adminUserId: "eval-admin", userId: "eval-user", adminKey, userKey };
}

export async function deleteDisposableAccount(
  runtime: OpenVikingRuntimeClient,
  root: ServerOpenVikingIdentity,
  accountId: string,
): Promise<void> {
  const accounts = createOpenVikingTypedAccountDelete({
    runtime,
    authorizedOwner: "eval-cleanup",
    adminIdentity: root,
  });
  const deleted = await accounts.deleteAccount({ accountId, owner: "eval-cleanup" });
  if (!deleted.ok) throw new Error(deleted.sanitizedError);
}
