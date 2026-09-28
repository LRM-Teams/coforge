import { afterAll, expect, mock, test } from "bun:test";

const displaySnapshots = new Map<string, string>();
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
      ) => Promise.all(scopes.map(snapshotFor)),
    };
  },
}));

const { resolveAgentUserInfo } = await import("#src/server/agents/agent-user-info.server");

afterAll(() => {
  mock.restore();
});

const WORKSPACE_ID = "workspace-1";
const CALLER_AGENT_ID = "agent-helper";

const AGENT_SCOUT = {
  id: "agent-scout",
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

/** The calling Agent's own identity (the `agentVisibilityViewerForActor` lookup), distinct
 * from `AGENT_SCOUT`'s owner so a private target is invisible to the default caller unless a test
 * explicitly says otherwise via `overrides.callerAgent`. */
const CALLER_IDENTITY = { ownerId: "user-caller-owner", role: "member" };

const USER_ALICE = {
  id: "user-alice",
  username: "alice",
  displayName: "Alice Chen",
  description: "Engineering lead.",
};

/** `#general`: caller + alice + scout. `#secret`: alice + scout, but NOT the caller — this
 * conversation must never be returned by `conversation.findMany`'s own caller-membership filter,
 * so the service can never see it, let alone leak it. */
function baseDb(overrides: { agent?: unknown; membership?: unknown; callerAgent?: unknown } = {}) {
  return {
    agent: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; name?: string; id?: string };
      }) => {
        // A `name`-keyed lookup resolves the requested target; an `id`-keyed lookup (no `name`)
        // is `agentVisibilityViewerForActor` resolving the CALLING Agent's own ownerId/role
        // — two different queries this same fake table answers.
        if (where.name === undefined) return overrides.callerAgent ?? CALLER_IDENTITY;
        if (overrides.agent !== undefined) return overrides.agent;
        return where.name === "scout" && where.workspaceId === WORKSPACE_ID ? AGENT_SCOUT : null;
      },
    },
    workspaceMembership: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; user: { username: string } };
      }) => {
        if (overrides.membership !== undefined) return overrides.membership;
        return where.user.username === "alice" && where.workspaceId === WORKSPACE_ID
          ? { role: "admin", user: USER_ALICE }
          : null;
      },
    },
    conversation: {
      findMany: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          members: { some: { agentId: string; leftAt: null } };
        };
      }) => {
        expect(where.workspaceId).toBe(WORKSPACE_ID);
        expect(where.members.some.leftAt).toBeNull();
        expect(typeof where.members.some.agentId).toBe("string");
        // Simulates Prisma's own filter: only conversations the caller is a member of are ever
        // returned. #secret (caller not a member) is never in this list.
        return [
          {
            channelName: "general",
            members: [{ channelRole: "member" }],
          },
        ];
      },
    },
  };
}

test("user info: human target returns visible facts and no Agent-only fields", async () => {
  const outcome = await resolveAgentUserInfo(
    baseDb() as never,
    {
      workspaceId: WORKSPACE_ID,
      agentId: CALLER_AGENT_ID,
    },
    "alice",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.user).toMatchObject({
    kind: "human",
    id: "user-alice",
    name: "alice",
    displayName: "Alice Chen",
    description: "Engineering lead.",
    role: "admin",
    isSelf: false,
  });
  expect(outcome.body.user).not.toHaveProperty("status");
  expect(outcome.body.memberships).toEqual([{ channel: "#general", role: "member" }]);
});

test("user info: Agent target reports live status from the shared display projection", async () => {
  displaySnapshots.set("agent-scout", "online");
  const outcome = await resolveAgentUserInfo(
    baseDb() as never,
    {
      workspaceId: WORKSPACE_ID,
      agentId: CALLER_AGENT_ID,
    },
    "scout",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.user).toMatchObject({
    kind: "agent",
    name: "scout",
    displayName: "Scout",
    role: "member",
    runtime: "claude-code",
    model: "sonnet",
    computerName: "Alice's Mac",
    status: "online",
    isSelf: false,
  });
  expect(outcome.body.user).not.toHaveProperty("availability");
  displaySnapshots.delete("agent-scout");
});

test("user info: offline + stopped Agent carries an availability reason", async () => {
  displaySnapshots.set("agent-scout", "offline");
  const stopped = { ...AGENT_SCOUT, stoppedAt: new Date("2026-09-17T00:00:00.000Z") };
  const outcome = await resolveAgentUserInfo(
    baseDb({ agent: stopped }) as never,
    {
      workspaceId: WORKSPACE_ID,
      agentId: CALLER_AGENT_ID,
    },
    "scout",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.user.status).toBe("offline");
  expect(outcome.body.user.availability).toBe("Stopped — won't receive messages until restarted");
  displaySnapshots.delete("agent-scout");
});

test("user info: an Agent with no assigned Computer reports unknown status", async () => {
  const noComputer = { ...AGENT_SCOUT, computerId: null };
  const outcome = await resolveAgentUserInfo(
    baseDb({ agent: noComputer }) as never,
    {
      workspaceId: WORKSPACE_ID,
      agentId: CALLER_AGENT_ID,
    },
    "scout",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.user.status).toBe("unknown");
});

test("user info: self is flagged when the target is the calling Agent", async () => {
  const outcome = await resolveAgentUserInfo(
    baseDb() as never,
    {
      workspaceId: WORKSPACE_ID,
      agentId: "agent-scout",
    },
    "scout",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.user.isSelf).toBe(true);
});

test("user info: an unknown name 404s as user_not_found", async () => {
  const outcome = await resolveAgentUserInfo(
    baseDb({ agent: null, membership: null }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    "ghost",
  );
  expect(outcome.status).toBe(404);
  if (outcome.status !== 404) throw new Error("unreachable");
  expect(outcome.body).toEqual({
    ok: false,
    errorCode: "user_not_found",
    error: 'No human or Agent named "ghost" in this Workspace.',
  });
});

test("user info: memberships never include a channel the caller cannot see", async () => {
  // baseDb's conversation.findMany asserts the caller-membership filter is always applied and
  // only ever returns "#general" (never "#secret"); this test pins that the response reflects
  // exactly that filtered set, not a superset.
  const outcome = await resolveAgentUserInfo(
    baseDb() as never,
    {
      workspaceId: WORKSPACE_ID,
      agentId: CALLER_AGENT_ID,
    },
    "alice",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.memberships.map((m) => m.channel)).toEqual(["#general"]);
  expect(outcome.body.memberships.some((m) => m.channel === "#secret")).toBe(false);
});

test("user info: a private Agent the caller cannot see answers agent_not_visible, not its details", async () => {
  const ghost = {
    ...AGENT_SCOUT,
    id: "agent-ghost",
    name: "ghost",
    ownerId: "user-owner-of-ghost",
    visibility: "private",
  };
  const outcome = await resolveAgentUserInfo(
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

test("user info: the private Agent's own creator can still resolve it", async () => {
  const ghost = {
    ...AGENT_SCOUT,
    id: "agent-ghost",
    name: "ghost",
    ownerId: CALLER_IDENTITY.ownerId,
    visibility: "private",
  };
  const outcome = await resolveAgentUserInfo(
    baseDb({ agent: ghost }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    "ghost",
  );
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("unreachable");
  expect(outcome.body.user).toMatchObject({ kind: "agent", name: "ghost" });
});

test("user info: a Workspace admin can still resolve someone else's private Agent", async () => {
  const ghost = {
    ...AGENT_SCOUT,
    id: "agent-ghost",
    name: "ghost",
    ownerId: "user-owner-of-ghost",
    visibility: "private",
  };
  const outcome = await resolveAgentUserInfo(
    baseDb({ agent: ghost, callerAgent: { ownerId: "user-caller-owner", role: "admin" } }) as never,
    { workspaceId: WORKSPACE_ID, agentId: CALLER_AGENT_ID },
    "ghost",
  );
  expect(outcome.status).toBe(200);
});
