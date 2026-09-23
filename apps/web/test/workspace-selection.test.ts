import { expect, test } from "bun:test";

import {
  memoizeForRequest,
  readPreferredWorkspaceSlug,
  serializeWorkspaceCookie,
} from "@/server/workspaces/selection.server";

test("the preferred Workspace cookie is host-only and readable from the header", () => {
  const cookie = serializeWorkspaceCookie("research", false);
  expect(cookie).toContain("coforge_workspace=research");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).not.toContain("Domain=");
  expect(cookie).not.toContain("Secure");
  expect(readPreferredWorkspaceSlug(`session=abc; ${cookie.split(";", 1)[0]}`)).toBe("research");
});

test("the selected Workspace is resolved once per request and user", async () => {
  const request = new Request("https://server.example/app");
  let loads = 0;
  const load = async () => {
    loads += 1;
    return "workspace-1";
  };

  const [first, second] = await Promise.all([
    memoizeForRequest(request, "user-1", load),
    memoizeForRequest(request, "user-1", load),
  ]);
  await memoizeForRequest(request, "user-2", load);
  await memoizeForRequest(new Request("https://server.example/other"), "user-1", load);

  expect([first, second]).toEqual(["workspace-1", "workspace-1"]);
  expect(loads).toBe(3);
});

test("a failed Workspace lookup is not cached for the request", async () => {
  const request = new Request("https://server.example/app");
  let loads = 0;
  const load = async () => {
    loads += 1;
    if (loads === 1) throw new Error("transient");
    return "workspace-1";
  };

  await expect(memoizeForRequest(request, "user-1", load)).rejects.toThrow("transient");
  await expect(memoizeForRequest(request, "user-1", load)).resolves.toBe("workspace-1");
});
