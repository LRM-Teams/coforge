import { expect, test } from "bun:test";

import {
  readPreferredWorkspaceSlug,
  serializeWorkspaceCookie,
} from "../src/server/workspaces/selection.server";

test("the preferred Workspace cookie is host-only and readable from the header", () => {
  const cookie = serializeWorkspaceCookie("research", false);
  expect(cookie).toContain("coforge_workspace=research");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).not.toContain("Domain=");
  expect(cookie).not.toContain("Secure");
  expect(readPreferredWorkspaceSlug(`session=abc; ${cookie.split(";", 1)[0]}`)).toBe("research");
});
