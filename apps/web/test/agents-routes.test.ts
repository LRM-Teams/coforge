import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";

import { formatAgentProfileParam } from "@/features/agents/profile-panel/profile-panel-search";
import { Route as agentDetailRoute } from "@/routes/_app/agents.$agentId";
import { Route as agentsRoute } from "@/routes/_app/agents.index";

test("Members uses the standard delayed, non-minimum pending transition", () => {
  expect(agentsRoute.options.pendingMs).toBe(300);
  expect(agentsRoute.options.pendingMinMs).toBe(0);
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
