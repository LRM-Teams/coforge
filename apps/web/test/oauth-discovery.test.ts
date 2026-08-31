import { expect, test } from "bun:test";

import { isNonLocalizedRequest } from "../src/server";

test("OAuth and API paths bypass Paraglide localization", () => {
  expect(
    isNonLocalizedRequest(new Request("http://localhost/.well-known/oauth-authorization-server")),
  ).toBe(true);
  expect(isNonLocalizedRequest(new Request("http://localhost/api/e2e/workspaces/demo"))).toBe(true);
  expect(isNonLocalizedRequest(new Request("http://localhost/oauth/device"))).toBe(true);
  expect(
    isNonLocalizedRequest(
      new Request("http://localhost/en/.well-known/oauth-authorization-server"),
    ),
  ).toBe(false);
  expect(isNonLocalizedRequest(new Request("http://localhost/en/settings"))).toBe(false);
});
