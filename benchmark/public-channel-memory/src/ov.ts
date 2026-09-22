import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export async function rotateEvalAdminKey(
  runtime: OpenVikingRuntimeClient,
  root: ServerOpenVikingIdentity,
  accountId: string,
): Promise<OvUsers> {
  const rotated = await readRuntimeJson(
    await runtime.request({
      method: "POST",
      path: `/api/v1/admin/accounts/${accountId}/users/eval-admin/key`,
      identity: root,
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  if (rotated.status >= 300) throw new Error(`typed admin key rotate failed status=${rotated.status}`);
  const adminKey = resultField(rotated.json).user_key;
  if (typeof adminKey !== "string" || adminKey.length === 0) {
    throw new Error("typed admin key rotate did not return a user key");
  }
  return { adminUserId: "eval-admin", userId: "eval-user", adminKey, userKey: adminKey };
}

async function readAccountKeyFile(path: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    const keys: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) keys[name] = value;
    }
    return keys;
  } catch {
    return {};
  }
}

export async function rememberEvalAccountKey(accountId: string, adminKey: string): Promise<void> {
  const path = Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;
  if (!path) throw new Error("openviking account key file is not configured");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const keys = await readAccountKeyFile(path);
  keys[`secret:ov-${accountId}`] = adminKey;
  await writeFile(path, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
}

export async function forgetEvalAccountKey(accountId: string): Promise<void> {
  const path = Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;
  if (!path) return;
  const keys = await readAccountKeyFile(path);
  delete keys[`secret:ov-${accountId}`];
  await writeFile(path, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
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
