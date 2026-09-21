import { describe, expect, test } from "bun:test";

import type { Prisma, PrismaClient } from "../generated/client";
import { isAppError } from "../src/lib/app-error";
import {
  agentVisibilityViewerForAgent,
  agentVisibilityViewerForUser,
  assertAgentVisible,
  canSeeAgent,
  type AgentVisibilityViewer,
  visibleAgentWhere,
} from "../src/server/agents/agent-visibility.server";

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
      name: "an admin-role Agent (ADR 0024) sees any private Agent",
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
});
