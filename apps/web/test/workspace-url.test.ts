import { expect, test } from "bun:test";

import { workspaceSlugFromPath } from "#src/features/workspaces/workspace-url";

test("the Workspace slug is read from a /w/<slug> path, with or without a locale", () => {
  expect(workspaceSlugFromPath("/w/acme")).toBe("acme");
  expect(workspaceSlugFromPath("/w/acme/channel/123")).toBe("acme");
  expect(workspaceSlugFromPath("/en/w/acme/dm/123")).toBe("acme");
  expect(workspaceSlugFromPath("/zh-CN/w/acme/")).toBe("acme");
});

test("a path outside /w/<slug> names no Workspace", () => {
  expect(workspaceSlugFromPath("/")).toBeUndefined();
  expect(workspaceSlugFromPath("/en/messages")).toBeUndefined();
  expect(workspaceSlugFromPath("/_serverFn/abc")).toBeUndefined();
  expect(workspaceSlugFromPath("/en/w/")).toBeUndefined();
  expect(workspaceSlugFromPath("/en/work/acme")).toBeUndefined();
});
