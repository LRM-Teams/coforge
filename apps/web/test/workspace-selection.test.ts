import { expect, test } from "bun:test";

import {
  memoizeForRequest,
  readPreferredWorkspaceSlug,
  serializeForgottenWorkspaceCookie,
  serializeWorkspaceCookie,
} from "#src/server/workspaces/selection.server";

test("the preferred Workspace cookie is host-only and readable from the header", () => {
  const cookie = serializeWorkspaceCookie("research", false);
  expect(cookie).toContain("coforge_workspace=research");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).not.toContain("Domain=");
  expect(cookie).not.toContain("Secure");
  expect(readPreferredWorkspaceSlug(`session=abc; ${cookie.split(";", 1)[0]}`)).toBe("research");
});

test("forgetting the preferred Workspace expires the same host-only cookie", () => {
  const cookie = serializeForgottenWorkspaceCookie(true);
  expect(cookie.split("; ")).toEqual([
    "coforge_workspace=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Secure",
  ]);
  expect(readPreferredWorkspaceSlug(cookie.split(";", 1)[0]!)).toBeUndefined();
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

test("the lookup is cached per key, so one request can serve two Workspaces", async () => {
  const request = new Request("https://server.example/app");
  const loads: string[] = [];
  const load = (slug: string) => async () => {
    loads.push(slug);
    return `workspace-${slug}`;
  };
  expect(await memoizeForRequest(request, "user-1/a", load("a"))).toBe("workspace-a");
  expect(await memoizeForRequest(request, "user-1/b", load("b"))).toBe("workspace-b");
  expect(await memoizeForRequest(request, "user-1/a", load("a"))).toBe("workspace-a");
  expect(loads).toEqual(["a", "b"]);
});
