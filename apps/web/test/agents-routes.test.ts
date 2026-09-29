import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";

import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { Route as agentDetailRoute } from "#src/routes/w.$workspaceSlug/agent.$agentId";
import { Route as agentsRoute } from "#src/routes/w.$workspaceSlug/members";

test("Members takes the shared pending policy instead of restating it", () => {
  // The delay and the minimum live once, in the router defaults (lib/pending-policy.ts); a route
  // that writes its own number is how they drifted apart in the first place.
  expect(agentsRoute.options.pendingMs).toBeUndefined();
  expect(agentsRoute.options.pendingMinMs).toBeUndefined();
  expect(agentsRoute.options.pendingComponent).toBeDefined();
});

test("an Agent's page opens Members with its profile panel", () => {
  const agentId = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
  const beforeLoad = agentDetailRoute.options.beforeLoad;
  expect(beforeLoad).toBeDefined();
  expect(agentDetailRoute.options.pendingMs).toBeUndefined();
  expect(agentDetailRoute.options.pendingComponent).toBeUndefined();

  let thrown: unknown;
  try {
    beforeLoad!({
      params: { workspaceSlug: "acme", agentId },
      search: { agentTab: "activity" },
    } as never);
  } catch (error) {
    thrown = error;
  }

  expect(isRedirect(thrown)).toBe(true);
  if (!isRedirect(thrown)) return;
  expect(thrown.options.to).toBe("/w/$workspaceSlug/members");
  // `params` is typed as a union with a reducer function too; the route passes the plain object.
  const params: unknown = thrown.options.params;
  expect(params).toEqual({ workspaceSlug: "acme" });
  expect(thrown.options.replace).toBe(true);
  // `redirect({ search })` is typed as a union that also includes `true` (keep the current
  // search) and a reducer function; narrow to the plain-object form this route actually passes so
  // the comparison below stays exact.
  const search = thrown.options.search as unknown as { profile: string; agentTab?: string };
  expect(search).toEqual({
    profile: formatAgentProfileParam(agentId),
    agentTab: "activity",
  });
});
