import { describe, expect, test } from "bun:test";

import { browserCookie, cookiePairs } from "#src/lib/browser-cookie";

describe("a cookie the browser writes for the server render", () => {
  test("lives for the time asked on every page, and is Secure only over https", () => {
    const cookie = browserCookie("seen", "a b", 31_536_000, true);
    expect(cookie).toContain("seen=a%20b");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(browserCookie("seen", "x", 60, false)).not.toContain("Secure");
  });

  test("comes back as the pairs a request's Cookie header carries", () => {
    expect(cookiePairs("theme=dark; seen=a%20b;  empty=")).toEqual([
      ["theme", "dark"],
      ["seen", "a%20b"],
      ["empty", ""],
    ]);
    expect(cookiePairs("a=b=c")).toEqual([["a", "b=c"]]);
  });

  test("ignores what is not a pair, and no header at all", () => {
    expect(cookiePairs("garbage; =nameless; ok=1")).toEqual([["ok", "1"]]);
    expect(cookiePairs(undefined)).toEqual([]);
    expect(cookiePairs("")).toEqual([]);
  });
});
