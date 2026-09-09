import { expect, test } from "bun:test";

import { Route as computerDetailRoute } from "@/routes/_app/computers.$computerId";
import { Route as computersRoute } from "@/routes/_app/computers";

test("Computer routes use the approved delayed loading feedback", () => {
  expect(computersRoute.options.pendingMs).toBe(300);
  expect(computersRoute.options.pendingMinMs).toBe(0);
  expect(computersRoute.options.pendingComponent).toBeDefined();
  expect(computerDetailRoute.options.pendingMs).toBe(300);
  expect(computerDetailRoute.options.pendingMinMs).toBe(0);
  expect(computerDetailRoute.options.pendingComponent).toBeDefined();
  expect(computerDetailRoute.options.errorComponent).toBeDefined();
});
