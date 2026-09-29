/**
 * F6 explicit opt-in real OpenViking smoke.
 *
 * Filename is `*.smoke.ts` on purpose: default `bun test` / `mise run test`
 * only discover `*.test.{js,ts,...}` and `*.spec.{js,ts,...}`. This file is
 * never collected unless it is passed by path.
 *
 * Pinned runtime: OpenViking e44ea6e11add1c7b3d4accdbfaf16e900a6049df
 * plus the local-embed layer. Synthetic data only.
 *
 *   OPENVIKING_SMOKE=1 \
 *   COFORGE_OPENVIKING_URL=http://127.0.0.1:1933 \
 *   OPENVIKING_PROTOTYPE_CONF=infra/secrets/openviking_prototype_ov_conf \
 *   bun test ./apps/web/test/openviking-prototype.smoke.ts
 *
 * Load the root key from the secret file in-process. Do not put the key on
 * argv, in fixtures, or in logs.
 */

import { expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceMemoryCitationStore } from "../src/server/db/repositories/workspace-memory-citation.repositories.server";
import { createMemoryCitationBindings } from "../src/server/workspace-memory/memory-citations";
import {
  composeOpenVikingGatewayContext,
  createOpenVikingPolicyGateway,
} from "../src/server/openviking/policy-gateway.server";
import { DEFAULT_OPENVIKING_TRANSPORT_LIMITS } from "../src/server/openviking/route-policy";
import {
  createOpenVikingRuntimeClient,
  type OpenVikingRuntimeClient,
  type OpenVikingRuntimeResult,
} from "../src/server/openviking/runtime-client.server";
import { createInMemoryOpenVikingBindingStore } from "../src/server/openviking/stores";
import type { ServerOpenVikingIdentity } from "../src/server/openviking/route-policy";
import { createOpenVikingTypedAccountDelete } from "../src/server/openviking/typed-account-delete.server";
import { createOpenVikingTypedSessionExtract } from "../src/server/openviking/typed-session-extract.server";
import { detectAdmittedPublicChannelSegments } from "../src/server/workspace-memory/detect-segments";
import {
  admittedSessionWriteFromDelivery,
  createOpenVikingAdmittedDeliverySink,
} from "../src/server/workspace-memory/ov-sink.server";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../src/server/workspace-memory/profile";
import {
  createInMemoryWorkspaceMemoryProfileStore,
  saveProfileTransition,
} from "../src/server/workspace-memory/stores";
import {
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
  WORKSPACE_MEMORY_PG_URL,
} from "./helpers/workspace-memory-pg";

export const OPENVIKING_PINNED_REVISION = "e44ea6e11add1c7b3d4accdbfaf16e900a6049df";
export const OPENVIKING_EMBED_LAYER = "local-embed";

const SMOKE_FLAG = "OPENVIKING_SMOKE";
const URL_FLAG = "COFORGE_OPENVIKING_URL";
const CONF_FLAG = "OPENVIKING_PROTOTYPE_CONF";
const DEFAULT_CONF = new URL("../../../infra/secrets/openviking_prototype_ov_conf", import.meta.url)
  .pathname;

const optedIn = Bun.env[SMOKE_FLAG] === "1" || Bun.env[SMOKE_FLAG] === "true";
const baseUrl = Bun.env[URL_FLAG] ?? "";
const confPath = Bun.env[CONF_FLAG] ?? DEFAULT_CONF;
const pgUrl = WORKSPACE_MEMORY_PG_URL;
const canRun = optedIn && baseUrl.length > 0 && confPath.length > 0;

if (!optedIn || !baseUrl || !confPath) {
  console.warn(
    `openviking prototype smoke skipped: set ${SMOKE_FLAG}=1, ${URL_FLAG}, and ${CONF_FLAG} (secret file path, not the key)`,
  );
}
if (optedIn) warnIfWorkspaceMemoryPgSkipped("openviking prototype smoke citations");

const SMOKE_TIMEOUT_MS = 180_000;
const SMOKE_LIMITS = {
  ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  maxRequestBytes: 8_388_608,
  timeoutMs: 120_000,
} as const;

const SECRET_PATTERN = /Bearer\s+\S+|user_key|root_api_key|api[_-]?key|authorization/gi;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function sanitizeDiagnostic(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.replace(SECRET_PATTERN, "[redacted]");
}

function rootIdentity(rootKey: string): ServerOpenVikingIdentity {
  return {
    accountId: "root",
    userId: "smoke-root",
    role: "admin",
    authorization: `Bearer ${rootKey}`,
  };
}

function userIdentity(
  accountId: string,
  userId: string,
  userKey: string,
  role: "admin" | "user" = "user",
): ServerOpenVikingIdentity {
  return {
    accountId,
    userId,
    role,
    authorization: `Bearer ${userKey}`,
  };
}

async function readSecretRootKey(path: string): Promise<string> {
  const raw = await Bun.file(path).text();
  const parsed = JSON.parse(raw) as { server?: { root_api_key?: unknown } };
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
  if (!result.ok) {
    throw new Error(`openviking transport ${result.failure.code}`);
  }
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

function collectUris(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string" && value.startsWith("viking://")) into.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectUris(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectUris(item, into);
  }
  return into;
}

function summarizeSearch(
  label: string,
  response: { status: number; json: Record<string, unknown> | null },
): string {
  const result = resultField(response.json);
  const uris = collectUris(response.json);
  return sanitizeDiagnostic(
    `${label} status=${response.status} keys=${Object.keys(result).join(",")} uris=${uris.length} first=${uris[0] ?? ""}`,
  );
}

function containsFactUri(uris: readonly string[], taggedUri: string): boolean {
  return uris.some((uri) => uri === taggedUri || uri.includes("fact-synth-1"));
}

const TAG_FILTER = {
  op: "and",
  conds: [
    { op: "must", field: "search_tags", conds: ["cm_fact=fact-synth-1"] },
    { op: "must", field: "search_tags", conds: ["cm_ver=3"] },
    { op: "must", field: "search_tags", conds: ["cm_gen=7"] },
  ],
} as const;

function encodeMultipartFile(
  filename: string,
  content: string,
): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = `----ovSmoke${crypto.randomUUID().replaceAll("-", "")}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const encoder = new TextEncoder();
  const headBytes = encoder.encode(head);
  const contentBytes = encoder.encode(content);
  const tailBytes = encoder.encode(tail);
  const body = new Uint8Array(headBytes.length + contentBytes.length + tailBytes.length);
  body.set(headBytes, 0);
  body.set(contentBytes, headBytes.length);
  body.set(tailBytes, headBytes.length + contentBytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function requestJson(
  runtime: OpenVikingRuntimeClient,
  identity: ServerOpenVikingIdentity,
  input: { method: string; path: string; query?: Record<string, string>; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return readRuntimeJson(
    await runtime.request({
      method: input.method,
      path: input.path,
      query: input.query,
      identity,
      headers: input.body === undefined ? undefined : { "content-type": "application/json" },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
  );
}

async function provisionDisposableAccount(
  runtime: OpenVikingRuntimeClient,
  root: ServerOpenVikingIdentity,
  accountId: string,
): Promise<{ adminUserId: string; userId: string; adminKey: string; userKey: string }> {
  const created = await requestJson(runtime, root, {
    method: "POST",
    path: "/api/v1/admin/accounts",
    body: { account_id: accountId, admin_user_id: "smoke-admin" },
  });
  if (created.status >= 300) {
    throw new Error(`typed account create failed status=${created.status}`);
  }
  const createdResult = resultField(created.json);
  const adminKey = createdResult.user_key;
  if (typeof adminKey !== "string" || adminKey.length === 0) {
    throw new Error("typed account create did not return a user key");
  }
  const registered = await requestJson(runtime, root, {
    method: "POST",
    path: `/api/v1/admin/accounts/${accountId}/users`,
    body: { user_id: "smoke-user", role: "user" },
  });
  if (registered.status >= 300) {
    throw new Error(`typed user create failed status=${registered.status}`);
  }
  const registeredResult = resultField(registered.json);
  const userKey = registeredResult.user_key;
  if (typeof userKey !== "string" || userKey.length === 0) {
    throw new Error("typed user create did not return a user key");
  }
  return {
    adminUserId: "smoke-admin",
    userId: "smoke-user",
    adminKey,
    userKey,
  };
}

async function listAccountIds(
  runtime: OpenVikingRuntimeClient,
  root: ServerOpenVikingIdentity,
  accountId: string,
): Promise<string[]> {
  const listed = await requestJson(runtime, root, {
    method: "GET",
    path: "/api/v1/admin/accounts",
    query: { name: accountId },
  });
  const result = listed.json?.result;
  const rows = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { accounts?: unknown }).accounts)
      ? (result as { accounts: unknown[] }).accounts
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const id = (row as { account_id?: unknown }).account_id;
    return typeof id === "string" ? [id] : [];
  });
}

async function awaitAccountGone(
  runtime: OpenVikingRuntimeClient,
  root: ServerOpenVikingIdentity,
  accountId: string,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ids = await listAccountIds(runtime, root, accountId);
    if (!ids.includes(accountId)) return true;
    await delay(250);
  }
  return !(await listAccountIds(runtime, root, accountId)).includes(accountId);
}

async function readyGatewayStores(workspaceId: string, accountId: string) {
  const profiles = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const now = new Date("2026-09-22T01:00:00.000Z");
  const seed = createDefaultWorkspaceMemoryProfile(workspaceId);
  const selected = applyWorkspaceMemoryCommand(
    seed,
    { type: "select_desired", desired: "openviking", at: now },
    { prototypeEnabled: true },
  );
  if (!selected.ok) throw new Error(selected.failure.code);
  const ready = applyWorkspaceMemoryCommand(selected.profile, {
    type: "observe_ready",
    generation: selected.profile.generation,
  });
  if (!ready.ok) throw new Error(ready.failure.code);
  if ((await saveProfileTransition(profiles, seed, ready.profile)) !== "saved") {
    throw new Error("profile transition was not saved");
  }
  if (
    (await bindings.compareAndSet({
      workspaceId,
      expectedGeneration: 0,
      binding: {
        workspaceId,
        accountId,
        serviceIdentityId: `svc-${accountId}`,
        credentialRef: `secret:ov-${accountId}`,
        generation: ready.profile.generation,
      },
    })) !== "saved"
  ) {
    throw new Error("binding was not saved");
  }
  return { profiles, bindings };
}

test.skipIf(!canRun)(
  "opt-in real OpenViking smoke provisions, gateways, extracts, finds tags, cites, and deletes",
  async () => {
    console.log(
      `openviking smoke revision=${OPENVIKING_PINNED_REVISION} embed=${OPENVIKING_EMBED_LAYER}`,
    );
    const rootKey = await readSecretRootKey(confPath);
    const runtime = createOpenVikingRuntimeClient({ baseUrl, limits: SMOKE_LIMITS });
    const root = rootIdentity(rootKey);
    const accountId = `smoke-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const workspaceId = crypto.randomUUID();
    const steps: Record<string, string> = {};
    let provisioned = false;
    try {
      const health = await fetch(new URL("/health", baseUrl));
      expect(health.status).toBe(200);
      steps.health = "real GET /health 200";

      const users = await provisionDisposableAccount(runtime, root, accountId);
      provisioned = true;
      steps.provision = "typed POST /api/v1/admin/accounts + users (real HTTP)";
      expect(JSON.stringify(steps)).not.toMatch(/Bearer |user_key/);

      const failClosed = await composeOpenVikingGatewayContext({
        request: new Request("http://web.local/api/openviking/proxy"),
        workspaceId,
        ovPath: "/api/v1/search/find",
      });
      expect(failClosed).toBeInstanceOf(Response);
      if (failClosed instanceof Response) {
        expect(failClosed.status).toBe(401);
        const body = await failClosed.json();
        expect(body).toMatchObject({ code: "capability_denied" });
        expect(JSON.stringify(body)).not.toMatch(/Bearer |root_api_key|user_key/);
      }
      steps.gatewayRoute =
        "composeOpenVikingGatewayContext fail-closed 401 (no server-held credentials; not a real OV call)";

      const { profiles, bindings } = await readyGatewayStores(workspaceId, accountId);
      const gateway = createOpenVikingPolicyGateway({
        profiles,
        bindings,
        runtime,
        resolveAuthorization: async () => `Bearer ${users.userKey}`,
      });
      const member = { kind: "member" as const, userId: "u-smoke" };
      const taggedUri = `viking://resources/cm-projection/${accountId}/facts/fact-synth-1.md`;
      const taggedBody =
        "synthetic fact document for openviking smoke tag round-trip. cm_fact fact-synth-1.";
      const findBody = {
        query: "synthetic fact document",
        target_uri: `viking://resources/cm-projection/${accountId}/`,
        limit: 10,
        level: "2",
        tags: ["cm_fact=fact-synth-1", "cm_ver=3", "cm_gen=7"],
      };

      const findThroughGateway = await gateway.forward(member, {
        workspaceId,
        method: "POST",
        path: "/api/v1/search/find",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(findBody),
      });
      expect(findThroughGateway.ok).toBe(true);
      if (!findThroughGateway.ok) throw new Error(findThroughGateway.failure.code);
      const findRead = await readRuntimeJson(findThroughGateway);
      expect(findRead.status).toBeLessThan(500);
      steps.gatewayFind = `real policy-gateway POST /api/v1/search/find status=${findRead.status}`;

      const upload = encodeMultipartFile("smoke-resource.md", taggedBody);
      const uploaded = await readRuntimeJson(
        await runtime.request({
          method: "POST",
          path: "/api/v1/resources/temp_upload",
          identity: userIdentity(accountId, users.userId, users.userKey),
          headers: { "content-type": upload.contentType },
          body: upload.body,
        }),
      );
      const tempFileId = resultField(uploaded.json).temp_file_id;
      expect(uploaded.status).toBeLessThan(300);
      expect(typeof tempFileId).toBe("string");
      const resourceWrite = await gateway.forward(member, {
        workspaceId,
        method: "POST",
        path: "/api/v1/resources",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          temp_file_id: tempFileId,
          to: `viking://resources/smoke-${accountId}.md`,
          wait: true,
          processing_mode: "vectors_only",
        }),
      });
      expect(resourceWrite.ok).toBe(true);
      if (!resourceWrite.ok) throw new Error(resourceWrite.failure.code);
      const resourceRead = await readRuntimeJson(resourceWrite);
      expect(resourceRead.status).toBeLessThan(500);
      steps.gatewayWrite = `real policy-gateway POST /api/v1/resources status=${resourceRead.status}`;

      const detected = detectAdmittedPublicChannelSegments({
        conversations: [{ id: "ch-smoke", workspaceId, channelName: "smoke" }],
        messages: [
          {
            id: "m-smoke",
            conversationId: "ch-smoke",
            workspaceId,
            sequence: 1,
            createdAt: new Date("2026-09-22T01:05:00.000Z"),
            body: "synthetic standup note for openviking session extract",
            senderKind: "human",
            senderHandle: "smoke",
          },
        ],
        tasks: [],
        admittedMessageIds: new Set(),
        now: new Date("2026-09-22T01:30:00.000Z"),
        quietAfterMs: 15 * 60 * 1000,
      })[0];
      expect(detected).toBeDefined();
      const sessions = createOpenVikingTypedSessionExtract({
        runtime,
        authorizedOwner: "sink-owner",
        sinkIdentity: userIdentity(accountId, users.adminUserId, users.adminKey, "admin"),
      });
      const sink = createOpenVikingAdmittedDeliverySink({
        sessions,
        owner: "sink-owner",
      });
      const delivery = {
        operationId: `ingest-${detected!.segmentId}`,
        turns: detected!.turns,
        segment: {
          segmentId: detected!.segmentId,
          sourceMessageIds: detected!.sourceMessageIds,
          workspace: detected!.workspace,
          kind: detected!.kind,
          conversationKind: detected!.conversationKind,
          sourcePayloadHash: detected!.sourcePayloadHash,
          profileGeneration: 1,
          closedAt: detected!.closedAt,
        },
      };
      const write = admittedSessionWriteFromDelivery(delivery);
      expect(JSON.stringify(write)).not.toMatch(
        /causal|cm_fact|cm_ver|provenance|audit_id|fact_id/,
      );
      const extracted = await sink.deliver(delivery);
      expect(extracted.outcome).toBe("delivered");
      steps.sessionExtract = "real typed session create→batch→commit→extract via F1 admitted sink";

      const reader = userIdentity(accountId, users.adminUserId, users.adminKey, "admin");
      const taggedWrite = await requestJson(runtime, reader, {
        method: "POST",
        path: "/api/v1/content/write",
        body: {
          uri: taggedUri,
          content: taggedBody,
          mode: "replace",
          wait: true,
          timeout: 90,
          tags: ["cm_fact=fact-synth-1", "cm_ver=3", "cm_gen=7"],
          tag_mode: "replace",
        },
      });
      expect(taggedWrite.status).toBeLessThan(300);
      const written = resultField(taggedWrite.json);
      const writtenUri = typeof written.uri === "string" ? written.uri : taggedUri;
      const readBack = await requestJson(runtime, reader, {
        method: "GET",
        path: "/api/v1/content/read",
        query: { uri: writtenUri },
      });
      expect(readBack.status).toBeLessThan(300);
      if (written.vector_status !== "complete") {
        const reindexed = await requestJson(runtime, reader, {
          method: "POST",
          path: "/api/v1/content/reindex",
          body: {
            uri: `viking://resources/cm-projection/${accountId}`,
            mode: "vectors_only",
            wait: true,
            timeout: 90,
            tags: ["cm_fact=fact-synth-1", "cm_ver=3", "cm_gen=7"],
            tag_mode: "replace",
          },
        });
        expect(reindexed.status).toBeLessThan(300);
      }
      const findAttempts = [
        findBody,
        {
          query: findBody.query,
          target_uri: findBody.target_uri,
          limit: 10,
          filter: TAG_FILTER,
        },
        {
          query: findBody.query,
          limit: 10,
          tags: findBody.tags,
        },
      ];
      let found: { status: number; json: Record<string, unknown> | null } | null = null;
      let foundUris: string[] = [];
      const findDeadline = Date.now() + 60_000;
      while (Date.now() < findDeadline && !containsFactUri(foundUris, writtenUri)) {
        for (const body of findAttempts) {
          found = await requestJson(runtime, reader, {
            method: "POST",
            path: "/api/v1/search/find",
            body,
          });
          expect(found.status).toBeLessThan(300);
          foundUris = collectUris(found.json);
          if (containsFactUri(foundUris, writtenUri)) break;
        }
        if (containsFactUri(foundUris, writtenUri)) break;
        await delay(500);
      }
      if (!containsFactUri(foundUris, writtenUri)) {
        const untagged = await requestJson(runtime, reader, {
          method: "POST",
          path: "/api/v1/search/find",
          body: { query: findBody.query, target_uri: findBody.target_uri, limit: 10 },
        });
        throw new Error(
          `tag find missed written uri writeStatus=${taggedWrite.status} vector=${String(written.vector_status)} read=${readBack.status} ${summarizeSearch("find(tags)", found ?? { status: 0, json: null })} ${summarizeSearch("find(untagged)", untagged)}`,
        );
      }
      const stale = await requestJson(runtime, reader, {
        method: "POST",
        path: "/api/v1/search/find",
        body: {
          ...findBody,
          tags: ["cm_fact=fact-synth-1", "cm_ver=3", "cm_gen=8"],
        },
      });
      expect(containsFactUri(collectUris(stale.json), writtenUri)).toBe(false);
      steps.tagFind =
        "real content/write tags + find(tags/filter) round-trip; GET /fs/attrs not used (V1.4)";

      if (!pgUrl) {
        steps.citation =
          "skipped (no MIGRATION_TEST_DATABASE_URL / CHANNEL_TEST_DATABASE_URL / DATABASE_URL)";
      } else {
        const pool = new Pool({ connectionString: pgUrl });
        const schema = `ov_smoke_${crypto.randomUUID().replaceAll("-", "")}`;
        let client: PoolClient | null = null;
        try {
          client = await pool.connect();
          await client.query(`CREATE SCHEMA "${schema}"`);
          await client.query(`SET search_path TO "${schema}"`);
          await applyWorkspaceMemoryPgStub(client, { workspaceIds: [workspaceId] });
          const db = new PrismaClient({
            adapter: new PrismaPg({ connectionString: pgUrl }, { schema }),
          });
          try {
            const citations = new PrismaWorkspaceMemoryCitationStore(db);
            const bindingsCitations = createMemoryCitationBindings({
              openviking: citations,
            });
            const [bound] = await bindingsCitations.bindOpenVikingHits(
              workspaceId,
              "smoke-find-1",
              [
                {
                  citationId: `ov:${taggedUri}`,
                  workspaceId,
                  accountId,
                  uri: taggedUri,
                  contentHash: "sha256:smoke-fact-synth-1",
                  matchedLevel: "L2",
                  excerpt: "synthetic fact document",
                },
              ],
            );
            expect(bound?.kind).toBe("openviking");
            expect(
              (await citations.getOpenVikingCitation(workspaceId, `ov:${taggedUri}`))
                ?.boundOperationId,
            ).toBe("smoke-find-1");
            steps.citation = "real PG OpenViking citation persist (P3)";
          } finally {
            await db.$disconnect();
          }
        } catch (error) {
          const code =
            typeof error === "object" && error && "code" in error
              ? String((error as { code: unknown }).code)
              : "";
          if (code === "28P01" || code === "ECONNREFUSED" || code === "ENOTFOUND") {
            steps.citation = `skipped (PostgreSQL unavailable code=${code})`;
          } else {
            throw error;
          }
        } finally {
          if (client) {
            await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            client.release();
          }
          await pool.end();
        }
      }

      expect(JSON.stringify(steps)).not.toMatch(/Bearer |[0-9a-f]{32,}/i);
      for (const [name, detail] of Object.entries(steps)) {
        console.log(`openviking smoke step ${name}: ${sanitizeDiagnostic(detail)}`);
      }
    } finally {
      if (provisioned) {
        const accounts = createOpenVikingTypedAccountDelete({
          runtime,
          authorizedOwner: "cleanup-owner",
          adminIdentity: root,
        });
        const deleted = await accounts.deleteAccount({
          accountId,
          owner: "cleanup-owner",
        });
        expect(deleted).toEqual({ ok: true });
        // Upstream (OV e44ea6e, alpha) accepts the typed DELETE with 202 but its
        // account registry settles asynchronously and may keep listing the id
        // long after data removal. Cleanup is satisfied by the accepted delete;
        // the settled state is recorded, not asserted.
        const gone = await awaitAccountGone(runtime, root, accountId);
        console.log(
          `openviking smoke cleanup: typed DELETE account ${accountId} accepted, gone=${gone} (registry settling is upstream-async)`,
        );
      }
    }
  },
  SMOKE_TIMEOUT_MS,
);
