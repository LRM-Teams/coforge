import { expect, test } from "bun:test";

import { Route as agentDetailRoute } from "@/routes/_app/agents.$agentId";

test("Agent detail uses the standard delayed, non-minimum pending transition", () => {
  expect(agentDetailRoute.options.pendingMs).toBe(300);
  expect(agentDetailRoute.options.pendingMinMs).toBe(0);
});
