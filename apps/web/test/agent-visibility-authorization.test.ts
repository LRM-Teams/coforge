import { describe, expect, test } from "bun:test";

import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import {
  agentVisibilityViewerForActor,
  agentVisibilityViewerForAgent,
  agentVisibilityViewerForUser,
  assertAgentVisible,
  canSeeAgent,
  type AgentVisibilityViewer,
  visibleAgentWhere,
  visiblePrivateAgentWhere,
} from "#src/server/agents/agent-visibility.server";

const WORKSPACE_ID = "workspace-1";
const CREATOR = "user-creator";
const OTHER_MEMBER = "user-other-member";
const ADMIN_USER = "user-admin";
const OWNER_USER = "user-owner";

const PRIVATE_AGENT = { visibility: "private", ownerId: CREATOR };
const PUBLIC_AGENT = { visibility: "public", ownerId: CREATOR };

const creatorViewer: AgentVisibilityViewer = { kind: "user", userId: CREATOR, role: "member" };
const sameCreatorAgentViewer: AgentVisibilityViewer = {
  kind: "agent",
  agentId: "agent-sibling",
  ownerId: CREATOR,
  role: "member",
};
const otherMemberViewer: AgentVisibilityViewer = {
  kind: "user",
  userId: OTHER_MEMBER,
  role: "member",
};
const otherMembersAgentViewer: AgentVisibilityViewer = {
  kind: "agent",
  agentId: "agent-other",
  ownerId: OTHER_MEMBER,
  role: "member",
};
const humanAdminViewer: AgentVisibilityViewer = { kind: "user", userId: ADMIN_USER, role: "admin" };
const adminRoleAgentViewer: AgentVisibilityViewer = {
  kind: "agent",
  agentId: "agent-admin",
  ownerId: OTHER_MEMBER,
  role: "admin",
};
const workspaceOwnerViewer: AgentVisibilityViewer = {
  kind: "user",
  userId: OWNER_USER,
  role: "owner",
};
const unrecognizedRoleViewer: AgentVisibilityViewer = {
  kind: "user",
  userId: OTHER_MEMBER,
  role: "owner-typo",
};
const noRoleViewer: AgentVisibilityViewer = {
  kind: "user",
  userId: OTHER_MEMBER,
  role: undefined,
};

describe("canSeeAgent", () => {
  const cases: Array<{ name: string; viewer: AgentVisibilityViewer; expected: boolean }> = [
    { name: "creator sees their own private Agent", viewer: creatorViewer, expected: true },
    {
      name: "an Agent sharing the same creator sees the private Agent, including itself",
      viewer: sameCreatorAgentViewer,
      expected: true,
    },
    {
      name: "another member cannot see the private Agent",
      viewer: otherMemberViewer,
      expected: false,
    },
    {
      name: "another member's Agent cannot see the private Agent",
      viewer: otherMembersAgentViewer,
      expected: false,
    },
    {
      name: "a human owner/admin sees any private Agent",
      viewer: humanAdminViewer,
      expected: true,
    },
    {
      name: "an admin-role Agent sees any private Agent",
      viewer: adminRoleAgentViewer,
      expected: true,
    },
    {
      name: "the Workspace owner sees any private Agent",
      viewer: workspaceOwnerViewer,
      expected: true,
    },
    {
      name: "an unrecognized server role fails closed (not admin-like)",
      viewer: unrecognizedRoleViewer,
      expected: false,
    },
    { name: "a missing server role fails closed", viewer: noRoleViewer, expected: false },
  ];

  for (const { name, viewer, expected } of cases) {
    test(`private Agent: ${name}`, () => {
      expect(canSeeAgent(viewer, PRIVATE_AGENT)).toBe(expected);
    });
  }

  test("a public Agent is visible to everyone, including a plain member and its Agent", () => {
    for (const viewer of [
      otherMemberViewer,
      otherMembersAgentViewer,
      creatorViewer,
      noRoleViewer,
    ]) {
      expect(canSeeAgent(viewer, PUBLIC_AGENT)).toBeTrue();
    }
  });

  test("an unrecognized visibility value (the column is a plain String) fails closed like private", () => {
    const oddAgent = { visibility: "hidden", ownerId: CREATOR };
    expect(canSeeAgent(creatorViewer, oddAgent)).toBeTrue();
    expect(canSeeAgent(otherMemberViewer, oddAgent)).toBeFalse();
    expect(canSeeAgent(humanAdminViewer, oddAgent)).toBeTrue();
  });
});

/** Interprets exactly the two `Prisma.AgentWhereInput` shapes `visibleAgentWhere` ever returns,
 * against a candidate Agent row, so the where-clause builder and `canSeeAgent` can be asserted to
 * agree row for row rather than only individually. */
function matchesAgentWhere(
  where: Prisma.AgentWhereInput,
  agent: { visibility: string; ownerId: string },
): boolean {
  if (Object.keys(where).length === 0) return true;
  const or = where.OR;
  if (!Array.isArray(or)) throw new Error("expected an OR clause");
  return or.some((clause) => {
    if (typeof clause !== "object" || clause === null) throw new Error("unexpected OR clause");
    if ("visibility" in clause) return clause.visibility === agent.visibility;
    if ("ownerId" in clause) return clause.ownerId === agent.ownerId;
    throw new Error("unexpected OR clause shape");
  });
}

describe("visibleAgentWhere agrees with canSeeAgent", () => {
  const roster = [
    { id: "a1", visibility: "private", ownerId: CREATOR },
    { id: "a2", visibility: "public", ownerId: CREATOR },
    { id: "a3", visibility: "private", ownerId: OTHER_MEMBER },
    { id: "a4", visibility: "public", ownerId: OTHER_MEMBER },
    // An unrecognized value (the column is a plain String): must fail closed like "private",
    // for both functions alike, never treated as visible by one and hidden by the other.
    { id: "a5", visibility: "hidden", ownerId: OTHER_MEMBER },
  ];
  const viewers: Array<{ name: string; viewer: AgentVisibilityViewer }> = [
    { name: "creator", viewer: creatorViewer },
    { name: "same-creator Agent", viewer: sameCreatorAgentViewer },
    { name: "other member", viewer: otherMemberViewer },
    { name: "other member's Agent", viewer: otherMembersAgentViewer },
    { name: "human admin", viewer: humanAdminViewer },
    { name: "admin-role Agent", viewer: adminRoleAgentViewer },
    { name: "Workspace owner", viewer: workspaceOwnerViewer },
    { name: "unrecognized role", viewer: unrecognizedRoleViewer },
    { name: "no role", viewer: noRoleViewer },
  ];

  for (const { name, viewer } of viewers) {
    test(`for the ${name} viewer, over every roster Agent`, () => {
      const where = visibleAgentWhere(viewer);
      for (const agent of roster) {
        expect(matchesAgentWhere(where, agent)).toBe(canSeeAgent(viewer, agent));
      }
    });
  }

  test("an owner/admin-like viewer gets the empty filter (nothing hidden)", () => {
    expect(visibleAgentWhere(humanAdminViewer)).toEqual({});
    expect(visibleAgentWhere(workspaceOwnerViewer)).toEqual({});
    expect(visibleAgentWhere(adminRoleAgentViewer)).toEqual({});
  });

  test("a plain viewer gets 'public, or mine'", () => {
    expect(visibleAgentWhere(otherMemberViewer)).toEqual({
      OR: [{ visibility: "public" }, { ownerId: OTHER_MEMBER }],
    });
    expect(visibleAgentWhere(otherMembersAgentViewer)).toEqual({
      OR: [{ visibility: "public" }, { ownerId: OTHER_MEMBER }],
    });
  });
});

/**
 * Realtime gap fix: an owner/admin (or a private Agent's creator) can see private
 * Agents beyond their own `listAgents` roster — e.g. another member's private Agent — and the
 * browser needs their ids to subscribe the matching per-Agent realtime channels. This predicate
 * must agree with `canSeeAgent` AND the routing rule every publisher already uses: anything other
 * than exactly `"public"` (not just the literal string `"private"`) is a per-Agent Agent.
 */
function matchesPrivateAgentWhere(
  where: Prisma.AgentWhereInput,
  agent: { visibility: string; ownerId: string },
): boolean {
  const not = where.NOT;
  if (!not || typeof not !== "object" || Array.isArray(not) || !("visibility" in not))
    throw new Error("expected a NOT visibility clause");
  if (not.visibility === agent.visibility) return false;
  const { NOT: _omit, ...rest } = where;
  return matchesAgentWhere(rest, agent);
}

describe("visiblePrivateAgentWhere", () => {
  const roster = [
    { id: "a1", visibility: "private", ownerId: CREATOR },
    { id: "a2", visibility: "public", ownerId: CREATOR },
    { id: "a3", visibility: "private", ownerId: OTHER_MEMBER },
    { id: "a4", visibility: "public", ownerId: OTHER_MEMBER },
    // An unrecognized value fails closed like "private" here too: the realtime routing itself
    // treats anything non-"public" as needing a per-Agent channel, so the subscription-id query
    // must match that, not just the literal string "private".
    { id: "a5", visibility: "hidden", ownerId: OTHER_MEMBER },
  ];
  const viewers: Array<{ name: string; viewer: AgentVisibilityViewer }> = [
    { name: "creator", viewer: creatorViewer },
    { name: "same-creator Agent", viewer: sameCreatorAgentViewer },
    { name: "other member", viewer: otherMemberViewer },
    { name: "other member's Agent", viewer: otherMembersAgentViewer },
    { name: "human admin", viewer: humanAdminViewer },
    { name: "admin-role Agent", viewer: adminRoleAgentViewer },
    { name: "Workspace owner", viewer: workspaceOwnerViewer },
  ];

  for (const { name, viewer } of viewers) {
    test(`for the ${name} viewer, over every roster Agent, agrees with canSeeAgent minus public`, () => {
      const where = visiblePrivateAgentWhere(viewer);
      for (const agent of roster) {
        const expected = canSeeAgent(viewer, agent) && agent.visibility !== "public";
        expect(matchesPrivateAgentWhere(where, agent)).toBe(expected);
      }
    });
  }

  test("an owner/admin sees every non-public Agent, including another member's", () => {
    const where = visiblePrivateAgentWhere(humanAdminViewer);
    expect(matchesPrivateAgentWhere(where, roster[2]!)).toBe(true); // a3: OTHER_MEMBER's private
    expect(matchesPrivateAgentWhere(where, roster[4]!)).toBe(true); // a5: OTHER_MEMBER's unrecognized
    expect(matchesPrivateAgentWhere(where, roster[1]!)).toBe(false); // a2: public
  });

  test("a plain member sees only their own private Agents, never another member's", () => {
    const where = visiblePrivateAgentWhere(creatorViewer);
    expect(matchesPrivateAgentWhere(where, roster[0]!)).toBe(true); // a1: CREATOR's own private
    expect(matchesPrivateAgentWhere(where, roster[2]!)).toBe(false); // a3: OTHER_MEMBER's private
  });
});

describe("assertAgentVisible", () => {
  test("throws AGENT_NOT_VISIBLE for a viewer who cannot see the Agent", () => {
    try {
      assertAgentVisible(otherMemberViewer, PRIVATE_AGENT);
      throw new Error("expected assertAgentVisible to throw");
    } catch (error) {
      expect(isAppError(error)).toBeTrue();
      expect(isAppError(error) && error.code).toBe("AGENT_NOT_VISIBLE");
    }
  });

  test("does not throw for a viewer who can see the Agent", () => {
    expect(() => assertAgentVisible(creatorViewer, PRIVATE_AGENT)).not.toThrow();
    expect(() => assertAgentVisible(otherMemberViewer, PUBLIC_AGENT)).not.toThrow();
  });
});

describe("viewer builders", () => {
  test("agentVisibilityViewerForUser resolves the human's Workspace role via the existing lookup", async () => {
    const db = {
      workspaceMembership: {
        findUnique: async () => ({ role: "admin" }),
      },
      agent: {
        findFirst: async () => {
          throw new Error("must not query the Agent table for a human viewer");
        },
      },
    } as unknown as Pick<PrismaClient, "workspaceMembership" | "agent">;

    const viewer = await agentVisibilityViewerForUser(db, WORKSPACE_ID, "user-1");
    expect(viewer).toEqual({ kind: "user", userId: "user-1", role: "admin" });
  });

  test("agentVisibilityViewerForUser leaves role undefined when the human has no membership", async () => {
    const db = {
      workspaceMembership: { findUnique: async () => null },
      agent: { findFirst: async () => null },
    } as unknown as Pick<PrismaClient, "workspaceMembership" | "agent">;

    const viewer = await agentVisibilityViewerForUser(db, WORKSPACE_ID, "user-1");
    expect(viewer).toEqual({ kind: "user", userId: "user-1", role: undefined });
  });

  test("agentVisibilityViewerForAgent maps an already-resolved Agent principal, no query", () => {
    const viewer = agentVisibilityViewerForAgent({
      id: "agent-1",
      ownerId: "owner-1",
      role: "member",
    });
    expect(viewer).toEqual({
      kind: "agent",
      agentId: "agent-1",
      ownerId: "owner-1",
      role: "member",
    });
  });

  test("agentVisibilityViewerForActor resolves a human actor through the Workspace membership lookup", async () => {
    const db = {
      workspaceMembership: { findUnique: async () => ({ role: "owner" }) },
      agent: {
        findFirst: async () => {
          throw new Error("must not query the Agent table for a human actor");
        },
      },
    } as unknown as Pick<PrismaClient, "workspaceMembership" | "agent">;

    const viewer = await agentVisibilityViewerForActor(db, WORKSPACE_ID, { userId: "user-1" });
    expect(viewer).toEqual({ kind: "user", userId: "user-1", role: "owner" });
  });

  test("agentVisibilityViewerForActor resolves an Agent actor's own ownerId and role in one query", async () => {
    const db = {
      workspaceMembership: {
        findUnique: async () => {
          throw new Error("must not query WorkspaceMembership for an Agent actor");
        },
      },
      agent: {
        findFirst: async (query: { where: { id: string; workspaceId: string } }) => {
          expect(query.where).toMatchObject({ id: "agent-1", workspaceId: WORKSPACE_ID });
          return { ownerId: "owner-1", role: "admin" };
        },
      },
    } as unknown as Pick<PrismaClient, "workspaceMembership" | "agent">;

    const viewer = await agentVisibilityViewerForActor(db, WORKSPACE_ID, { agentId: "agent-1" });
    expect(viewer).toEqual({
      kind: "agent",
      agentId: "agent-1",
      ownerId: "owner-1",
      role: "admin",
    });
  });

  test("agentVisibilityViewerForActor fails closed when the Agent actor cannot be found", async () => {
    const db = {
      workspaceMembership: { findUnique: async () => null },
      agent: { findFirst: async () => null },
    } as unknown as Pick<PrismaClient, "workspaceMembership" | "agent">;

    const viewer = await agentVisibilityViewerForActor(db, WORKSPACE_ID, { agentId: "unknown" });
    // No real owner can ever equal the empty string, so this viewer sees only public Agents —
    // the same fail-closed shape `isElevatedServerRole` already uses for an unrecognized role.
    expect(viewer).toEqual({ kind: "agent", agentId: "unknown", ownerId: "", role: undefined });
  });
});
