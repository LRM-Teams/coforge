import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";

import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { Route as agentDetailRoute } from "#src/routes/_app/agents.$agentId";
import { Route as agentsRoute } from "#src/routes/_app/agents.index";

test("Members takes the shared pending policy instead of restating it", () => {
  // The delay and the minimum live once, in the router defaults (lib/pending-policy.ts); a route
  // that writes its own number is how they drifted apart in the first place.
  expect(agentsRoute.options.pendingMs).toBeUndefined();
  expect(agentsRoute.options.pendingMinMs).toBeUndefined();
  expect(agentsRoute.options.pendingComponent).toBeDefined();
});

test("legacy Agent detail redirects to Members with the profile panel open", () => {
  const agentId = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
  const beforeLoad = agentDetailRoute.options.beforeLoad;
  expect(beforeLoad).toBeDefined();
  expect(agentDetailRoute.options.pendingMs).toBeUndefined();
  expect(agentDetailRoute.options.pendingComponent).toBeUndefined();

  let thrown: unknown;
  try {
    beforeLoad!({
      params: { agentId },
      search: { agentTab: "activity" },
    } as never);
  } catch (error) {
    thrown = error;
  }

  expect(isRedirect(thrown)).toBe(true);
  if (!isRedirect(thrown)) return;
  expect(thrown.options.to).toBe("/agents");
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

test("legacy Agent detail maps the old tab search param onto agentTab", () => {
  const agentId = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
  const beforeLoad = agentDetailRoute.options.beforeLoad;
  expect(beforeLoad).toBeDefined();

  let thrown: unknown;
  try {
    beforeLoad!({
      params: { agentId },
      search: { tab: "workspace" },
    } as never);
  } catch (error) {
    thrown = error;
  }

  expect(isRedirect(thrown)).toBe(true);
  if (!isRedirect(thrown)) return;
  const search = thrown.options.search as unknown as { profile: string; agentTab?: string };
  expect(search).toEqual({
    profile: formatAgentProfileParam(agentId),
    agentTab: "workspace",
  });
});
