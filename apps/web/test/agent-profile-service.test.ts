import { afterAll, expect, mock, test } from "bun:test";

const displaySnapshots = new Map<string, string>();
// How many batched display reads the profile's Agent list needed; one per list, not per Agent.
let displayBatchReads = 0;
mock.module("#src/server/agents/agent-display.server", () => ({
  getAgentDisplay: () => {
    const snapshotFor = async (scope: {
      workspaceId: string;
      computerId: string;
      agentId: string;
    }) => {
      const activityKind = displaySnapshots.get(scope.agentId);
      if (!activityKind) throw new Error("no snapshot");
      return {
        protocolMajor: 1 as const,
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        agentId: scope.agentId,
        revision: 1,
        activityKind,
        detailKind: activityKind === "online" ? "idle" : "",
        detail: "",
        entries: [],
        expiresAt: null,
      };
    };
    return {
      snapshot: snapshotFor,
      // The batched reader the Agent lists use: one call, the same per-scope answer, in order.
      snapshotMany: async (
        scopes: Array<{ workspaceId: string; computerId: string; agentId: string }>,
      ) => {
        displayBatchReads += 1;
        return Promise.all(scopes.map(snapshotFor));
      },
    };
  },
}));

const { createdAgentsFor, resolveAgentProfileShow, resolveAgentProfileUpdate } =
  await import("#src/server/agents/agent-profile.server");

afterAll(() => {
  mock.restore();
});

const WORKSPACE_ID = "workspace-1";
const CALLER_AGENT_ID = "agent-scout";

const AGENT_SCOUT = {
  id: "agent-scout",
  workspaceId: WORKSPACE_ID,
  name: "scout",
  displayName: "Scout",
  description: "Reviews pull requests.",
  role: "member",
  computerId: "computer-1",
  stoppedAt: null as Date | null,
  ownerId: "user-alice",
  visibility: "public",
  runtimeConfig: {
    runtime: "claude-code",
    provider: { kind: "default" },
    model: "sonnet",
    modelProvider: "",
    reasoning: "",
  },
  computer: { name: "mac-1", displayName: "Alice's Mac" },
};

const USER_ALICE = {
  id: "user-alice",
  username: "alice",
  displayName: "Alice Chen",
  description: "Engineering lead.",
};

function baseDb(
  overrides: {
    agent?: unknown;
    membership?: unknown;
    ownedAgents?: unknown[];
    update?: (data: Record<string, unknown>) => void;
  } = {},
) {
  const agentRecord = overrides.agent !== undefined ? overrides.agent : AGENT_SCOUT;
  return {
    agent: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; name?: string; id?: string };
      }) => {
        // A `name`-keyed lookup resolves the requested target; an `id`-keyed lookup (no `name`)
        // is `agentVisibilityViewerForActor` resolving the calling Agent's own ownerId/role
        // — here the caller always is `scout` itself.
        if (where.name === undefined) return { ownerId: AGENT_SCOUT.ownerId, role: "member" };
        if (!agentRecord) return null;
        return where.name === (agentRecord as { name: string }).name ? agentRecord : null;
      },
      findUnique: async ({ where }: { where: { id_workspaceId: { id: string } } }) =>
        where.id_workspaceId.id === CALLER_AGENT_ID ? { name: "scout" } : null,
      findMany: async () => overrides.ownedAgents ?? [],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        overrides.update?.(data);
        return { ...AGENT_SCOUT, ...data, name: "scout" };
      },
    },
    workspaceMembership: {
      findFirst: async ({ where }: { where: { user: { username: string } } }) =>
        where.user.username === "alice" ? { role: "admin", user: USER_ALICE } : null,
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "user-alice" ? USER_ALICE : null,
    },
    conversation: { findMany: async () => [] },
  };
}

test("profile show: defaults to the calling Agent's own profile when no target is given", async () => {
  displaySnapshots.set("agent-scout", "online");
  const outcome = await resolveAgentProfileShow(
    baseDb() as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    undefined,
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.profile).toMatchObject({
    kind: "agent",
    name: "scout",
    isSelf: true,
    status: "online",
  });
  if (outcome.body.profile.kind === "agent")
    expect(outcome.body.profile.creator).toEqual({ name: "alice", displayName: "Alice Chen" });
  displaySnapshots.delete("agent-scout");
});

test("profile show: a human target lists Agents they created", async () => {
  displaySnapshots.set("agent-scout", "offline");
  displaySnapshots.set("agent-archivist", "online");
  displayBatchReads = 0;
  const outcome = await resolveAgentProfileShow(
    baseDb({
      ownedAgents: [
        AGENT_SCOUT,
        { ...AGENT_SCOUT, id: "agent-archivist", name: "archivist", displayName: "Archivist" },
      ],
    }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    "alice",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.profile).toMatchObject({ kind: "human", name: "alice", isSelf: false });
  if (outcome.body.profile.kind === "human")
    expect(outcome.body.profile.createdAgents).toEqual([
      { name: "scout", displayName: "Scout", status: "offline" },
      { name: "archivist", displayName: "Archivist", status: "online" },
    ]);
  // Two Agents' live statuses, one round trip — the reason the batched reader exists.
  expect(displayBatchReads).toBe(1);
  displaySnapshots.delete("agent-scout");
  displaySnapshots.delete("agent-archivist");
});

test("profile show: an unknown target 404s as user_not_found", async () => {
  const outcome = await resolveAgentProfileShow(
    baseDb({ agent: null, membership: null }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    "ghost",
  );
  expect(outcome.status).toBe(404);
  if (outcome.status !== 404) throw new Error("unreachable");
  expect(outcome.body.errorCode).toBe("user_not_found");
});

test("profile update: applies displayName and description to the calling Agent only", async () => {
  let updateData: Record<string, unknown> | undefined;
  const outcome = await resolveAgentProfileUpdate(
    baseDb({ update: (data) => (updateData = data) }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    { displayName: "  Scout Bot  ", description: "Updated description." },
  );
  expect(outcome.status).toBe(200);
  expect(updateData).toEqual({ displayName: "Scout Bot", description: "Updated description." });
});

test("profile update: rejects an empty displayName as profile_invalid", async () => {
  const outcome = await resolveAgentProfileUpdate(
    baseDb() as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    { displayName: "   " },
  );
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("unreachable");
  expect(outcome.body.errorCode).toBe("profile_invalid");
  expect(outcome.body.error).toContain("must not be empty");
});

test("profile update: rejects a displayName over 80 characters", async () => {
  const outcome = await resolveAgentProfileUpdate(
    baseDb() as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    { displayName: "x".repeat(81) },
  );
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("unreachable");
  expect(outcome.body.errorCode).toBe("profile_invalid");
  expect(outcome.body.error).toContain("80 characters");
});

test("profile update: rejects a description over 500 characters", async () => {
  const outcome = await resolveAgentProfileUpdate(
    baseDb() as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    { description: "x".repeat(501) },
  );
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("unreachable");
  expect(outcome.body.errorCode).toBe("profile_invalid");
  expect(outcome.body.error).toContain("500 characters");
});

test("profile update: requires at least one field", async () => {
  const outcome = await resolveAgentProfileUpdate(
    baseDb() as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    {},
  );
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("unreachable");
  expect(outcome.body.errorCode).toBe("profile_invalid");
});

test("profile update: never accepts a name/Username field (the request type has none)", async () => {
  let updateData: Record<string, unknown> | undefined;
  await resolveAgentProfileUpdate(
    baseDb({ update: (data) => (updateData = data) }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    // @ts-expect-error -- deliberately probing that an extraneous `name` field is ignored, not
    // applied: `resolveAgentProfileUpdate`'s input type has no `name`/`username` field at all.
    { displayName: "Scout Bot", name: "renamed-scout" },
  );
  expect(updateData).toEqual({ displayName: "Scout Bot" });
  expect(updateData).not.toHaveProperty("name");
});

test("profile show: a private target Agent invisible to the caller answers agent_not_visible", async () => {
  const ghost = {
    ...AGENT_SCOUT,
    name: "ghost",
    ownerId: "user-someone-else",
    visibility: "private",
  };
  const outcome = await resolveAgentProfileShow(
    baseDb({ agent: ghost }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    "ghost",
  );
  expect(outcome.status).toBe(404);
  if (outcome.status !== 404) throw new Error("unreachable");
  expect(outcome.body).toEqual({
    ok: false,
    errorCode: "agent_not_visible",
    error: "@ghost is not visible to you.",
  });
});

test("createdAgentsFor: hides a private Agent from a viewer who is not its creator", async () => {
  let query: unknown;
  const otherUsersPrivateAgent = { ...AGENT_SCOUT, visibility: "private" };
  const db = {
    agent: {
      findMany: async (input: unknown) => {
        query = input;
        return [otherUsersPrivateAgent];
      },
    },
  } as never;
  const outsiderViewer = { kind: "user" as const, userId: "user-outsider", role: "member" };

  const agents = await createdAgentsFor(db, WORKSPACE_ID, "user-alice", outsiderViewer);

  expect(query).toMatchObject({
    where: {
      workspaceId: WORKSPACE_ID,
      ownerId: "user-alice",
      OR: [{ visibility: "public" }, { ownerId: "user-outsider" }],
    },
  });
  // The fake `findMany` ignores its own `where` (it always returns the row), so this proves the
  // *query* carries the filter — the real Prisma call is what actually excludes the row.
  expect(agents).not.toEqual([]);
});
