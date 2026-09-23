import { expect, test } from "bun:test";
import { Route } from "../src/routes/api/agent/v1/profile";

const handlers = Route.options.server!.handlers;
if (
  !handlers ||
  typeof handlers === "function" ||
  typeof handlers.GET !== "function" ||
  typeof handlers.POST !== "function"
)
  throw new Error("missing GET/POST handler");
const get = handlers.GET;
const post = handlers.POST;

const PRINCIPAL = { workspaceId: "workspace-1", agentId: "agent-scout" };

const AGENT_SCOUT = {
  id: "agent-scout",
  name: "scout",
  displayName: "Scout",
  description: "",
  role: "member",
  computerId: null as string | null,
  stoppedAt: null,
  ownerId: "user-alice",
  visibility: "public",
  runtimeConfig: {
    runtime: "claude-code",
    provider: { kind: "default" },
    model: "sonnet",
    modelProvider: "",
    reasoning: "",
  },
  computer: null,
};

function baseDb(overrides: { update?: (data: Record<string, unknown>) => void } = {}) {
  const state = { ...AGENT_SCOUT };
  return {
    agent: {
      findFirst: async ({ where }: { where: { name?: string } }) => {
        // A `name`-less `findFirst` is `agentVisibilityViewerForActor` resolving the calling
        // Agent's own ownerId/role; the caller here always is `scout` itself.
        if (where.name === undefined) return { ownerId: state.ownerId, role: state.role };
        return where.name === "scout" ? state : null;
      },
      findUnique: async () => ({ name: "scout" }),
      findMany: async () => [],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        overrides.update?.(data);
        Object.assign(state, data);
        return state;
      },
    },
    workspaceMembership: { findFirst: async () => null },
    user: {
      findUnique: async () => ({ id: "user-alice", username: "alice", displayName: "Alice Chen" }),
    },
    conversation: { findMany: async () => [] },
  };
}

async function getRequest(target?: string) {
  const url = target
    ? `http://local/api/agent/v1/profile?target=${encodeURIComponent(target)}`
    : "http://local/api/agent/v1/profile";
  return (await get({
    request: new Request(url),
    context: { principal: PRINCIPAL, db: baseDb() },
  } as unknown as Parameters<typeof get>[0])) as Response;
}

async function postRequest(body: unknown, db: ReturnType<typeof baseDb> = baseDb()) {
  return (await post({
    request: new Request("http://local/api/agent/v1/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context: { principal: PRINCIPAL, db },
  } as unknown as Parameters<typeof post>[0])) as Response;
}

test("GET /api/agent/v1/profile defaults to the calling Agent's own profile", async () => {
  const response = await getRequest();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    ok: boolean;
    profile: { kind: string; isSelf: boolean };
  };
  expect(body.ok).toBe(true);
  expect(body.profile).toMatchObject({ kind: "agent", isSelf: true });
});

test("POST /api/agent/v1/profile updates the calling Agent and rejects an invalid displayName", async () => {
  const db = baseDb();
  const ok = await postRequest({ displayName: "Scout Bot" }, db);
  expect(ok.status).toBe(200);

  const bad = await postRequest({ displayName: "" }, db);
  expect(bad.status).toBe(400);
  const body = (await bad.json()) as { ok: boolean; errorCode: string };
  expect(body).toMatchObject({ ok: false, errorCode: "profile_invalid" });
});

test("POST /api/agent/v1/profile ignores an unrecognized body field such as a name change", async () => {
  let updateData: Record<string, unknown> | undefined;
  const db = baseDb({ update: (data) => (updateData = data) });
  const response = await postRequest({ displayName: "Scout Bot", name: "renamed-scout" }, db);
  expect(response.status).toBe(200);
  expect(updateData).toEqual({ displayName: "Scout Bot" });
});
