import { expect, test } from "bun:test";

import { resolveReleaseFeedUrl } from "../src/release-channel";

test("an unset feed URL falls back to the production default", () => {
  expect(resolveReleaseFeedUrl(undefined)).toBe("https://releases.coforge.cn/");
  expect(resolveReleaseFeedUrl("")).toBe("https://releases.coforge.cn/");
});

test("a configured feed URL is used as-is", () => {
  expect(resolveReleaseFeedUrl("https://releases.staging.coforge.cn/")).toBe(
    "https://releases.staging.coforge.cn/",
  );
});

test("rejects a feed URL that is unusable rather than deferring the failure", () => {
  // The updater is constructed while commands are registered, so an unvalidated bad URL
  // surfaced as a bare TypeError from `login --help`, with nothing in CI to catch it.
  expect(() => resolveReleaseFeedUrl("not a url")).toThrow(/not a valid URL/);
  expect(() => resolveReleaseFeedUrl("http://releases.coforge.cn/")).toThrow(/must use HTTPS/);
});

/** `bun build --env=PREFIX_*` inlines only variables that are set while building; an unset one
 * stays a runtime lookup, so a binary built without release config would honour whatever
 * COFORGE_RELEASE_FEED_URL the environment happens to carry at install time. Exporting it as
 * "${VAR-}" makes the empty case inline too. */
test("the build script always sets the release feed variable so it inlines", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const build: string = manifest.scripts.build;

  expect(build).toContain('COFORGE_RELEASE_FEED_URL="${COFORGE_RELEASE_FEED_URL-}"');
  expect(build.indexOf("COFORGE_RELEASE_FEED_URL=")).toBeLessThan(build.indexOf("bun build"));
  expect(build).toContain("--env=COFORGE_RELEASE_*");
});
