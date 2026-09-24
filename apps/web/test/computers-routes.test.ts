import { expect, test } from "bun:test";

import { Route as computerDetailRoute } from "#src/routes/_app/computers.$computerId";
import { Route as computersRoute } from "#src/routes/_app/computers";

test("Computer routes take the shared pending policy instead of restating it", () => {
  expect(computersRoute.options.pendingMs).toBeUndefined();
  expect(computersRoute.options.pendingMinMs).toBeUndefined();
  expect(computersRoute.options.pendingComponent).toBeDefined();
  expect(computerDetailRoute.options.pendingMs).toBeUndefined();
  expect(computerDetailRoute.options.pendingMinMs).toBeUndefined();
  expect(computerDetailRoute.options.pendingComponent).toBeDefined();
  expect(computerDetailRoute.options.errorComponent).toBeDefined();
});
