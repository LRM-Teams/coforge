import { expect, test } from "bun:test";
import { Route } from "@/routes/api/agent/v1/users/$name";

const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.GET !== "function")
  throw new Error("missing GET handler");
const get = handlers.GET;

const PRINCIPAL = { workspaceId: "workspace-1", agentId: "agent-helper" };

function baseDb() {
  return {
    agent: {
      findFirst: async () => null,
    },
    workspaceMembership: {
      findFirst: async ({ where }: { where: { user: { username: string } } }) =>
        where.user.username === "alice"
          ? {
              role: "admin",
              user: {
                id: "user-alice",
                username: "alice",
                displayName: "Alice Chen",
                description: "",
              },
            }
          : null,
    },
    conversation: { findMany: async () => [] },
  };
}

async function request(name: string) {
  return (await get({
    context: { principal: PRINCIPAL, db: baseDb() },
    params: { name },
  } as unknown as Parameters<typeof get>[0])) as Response;
}

test("GET /api/agent/v1/users/:name returns the ok envelope for a known human", async () => {
  const response = await request("alice");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; user: { kind: string; name: string } };
  expect(body.ok).toBe(true);
  expect(body.user).toMatchObject({ kind: "human", name: "alice" });
});

test("GET /api/agent/v1/users/:name 404s with the Manual-style error envelope for an unknown name", async () => {
  const response = await request("ghost");
  expect(response.status).toBe(404);
  const body = (await response.json()) as { ok: boolean; errorCode: string; error: string };
  expect(body).toEqual({
    ok: false,
    errorCode: "user_not_found",
    error: 'No human or Agent named "ghost" in this Workspace.',
  });
});
