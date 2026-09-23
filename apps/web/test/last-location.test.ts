import { describe, expect, test } from "bun:test";

import { lastLocationCookie, restorableLastLocation } from "#src/lib/last-location";

/** The `name=value` pair a browser sends back for a cookie the app wrote. */
function sentBack(cookie: string | undefined): string {
  if (!cookie) throw new Error("no cookie was written");
  return cookie.split(";")[0]!;
}

describe("the last location opening the app root returns to", () => {
  test("comes back for the same Workspace", () => {
    const cookie = lastLocationCookie(
      { workspaceSlug: "acme", path: "/messages/channels/c1" },
      false,
    );
    expect(restorableLastLocation(`theme=dark; ${sentBack(cookie)}`, "acme")).toBe(
      "/messages/channels/c1",
    );
  });

  test("comes back when no Workspace was ever switched to", () => {
    const cookie = lastLocationCookie({ workspaceSlug: "acme", path: "/agents" }, false);
    expect(restorableLastLocation(sentBack(cookie), undefined)).toBe("/agents");
  });

  test("is dropped after switching to another Workspace", () => {
    const cookie = lastLocationCookie({ workspaceSlug: "acme", path: "/tasks" }, false);
    expect(restorableLastLocation(sentBack(cookie), "other")).toBeUndefined();
  });

  test("lives for 24 hours from the last page the user opened", () => {
    const cookie = lastLocationCookie({ workspaceSlug: "acme", path: "/tasks" }, true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=86400");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(lastLocationCookie({ workspaceSlug: "acme", path: "/tasks" }, false)).not.toContain(
      "Secure",
    );
  });

  test("is only ever an in-app page", () => {
    for (const path of ["/", "/login", "/api/me", "/oauth/callback", "/messagesx", "/landing"]) {
      expect(lastLocationCookie({ workspaceSlug: "acme", path }, false)).toBeUndefined();
    }
  });

  test("never sends the app root anywhere a forged cookie names", () => {
    const forged = [
      "//evil.example/messages",
      "/\\evil.example",
      "https://evil.example/messages",
      "/messages/../api/me",
      "/messages/channels/c1?x=1",
      "/messages/channels/c1#top",
      "javascript:alert(1)",
    ];
    for (const path of forged) {
      const value = encodeURIComponent(JSON.stringify({ workspaceSlug: "acme", path }));
      expect(restorableLastLocation(`coforge-last-location=${value}`, "acme")).toBeUndefined();
    }
    for (const value of [
      "",
      "not-json",
      encodeURIComponent("[]"),
      encodeURIComponent('{"path":1}'),
    ]) {
      expect(restorableLastLocation(`coforge-last-location=${value}`, "acme")).toBeUndefined();
    }
    expect(restorableLastLocation(undefined, "acme")).toBeUndefined();
  });
});
