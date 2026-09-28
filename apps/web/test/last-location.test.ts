import { describe, expect, test } from "bun:test";

import { lastLocationCookie, restorableLastLocation } from "#src/features/workspaces/last-location";

/** The `name=value` pair a browser sends back for a cookie the app wrote. */
function sentBack(cookie: string | undefined): string {
  if (!cookie) throw new Error("no cookie was written");
  return cookie.split(";")[0]!;
}

describe("the last location opening the app root returns to", () => {
  test("comes back to the page, in the Workspace its URL names", () => {
    const cookie = lastLocationCookie("/w/acme/channel/c1", false);
    expect(restorableLastLocation(`theme=dark; ${sentBack(cookie)}`)).toBe("/w/acme/channel/c1");
    expect(restorableLastLocation(sentBack(lastLocationCookie("/w/acme", false)))).toBe("/w/acme");
  });

  test("lives for 24 hours from the last page the user opened", () => {
    const cookie = lastLocationCookie("/w/acme/tasks", true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=86400");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(lastLocationCookie("/w/acme/tasks", false)).not.toContain("Secure");
  });

  test("is only ever an in-app page", () => {
    for (const path of [
      "/",
      "/login",
      "/api/me",
      "/oauth/callback",
      "/w",
      "/w/acme/nowhere",
      "/w/Bad_Slug/tasks",
      "/messages/channels/c1",
      "/landing",
    ]) {
      expect(lastLocationCookie(path, false)).toBeUndefined();
    }
  });

  test("never sends the app root anywhere a forged cookie names", () => {
    const forged = [
      "//evil.example/w/acme",
      "/\\evil.example",
      "https://evil.example/w/acme",
      "/w/acme/channel/../../../api/me",
      // Percent-encoded dot segments collapse when the path is parsed as a URL.
      "/w/acme/channel/%2e%2e/%2e%2e/%2e%2e/auth/logout",
      "/w/acme/channel/%2E%2E/api/me",
      "/w/acme/channel/.%2e/auth/logout",
      "/w/acme/channel/%2e./auth/logout",
      "/w/acme/channel/%2e/tasks",
      "/w/acme/channel/c1?x=1",
      "/w/acme/channel/c1#top",
      "javascript:alert(1)",
    ];
    for (const path of forged) {
      const value = encodeURIComponent(JSON.stringify({ path }));
      expect(restorableLastLocation(`coforge-last-location=${value}`)).toBeUndefined();
    }
    for (const value of [
      "",
      "not-json",
      encodeURIComponent("[]"),
      encodeURIComponent('{"path":1}'),
    ]) {
      expect(restorableLastLocation(`coforge-last-location=${value}`)).toBeUndefined();
    }
    expect(restorableLastLocation(undefined)).toBeUndefined();
  });
});
