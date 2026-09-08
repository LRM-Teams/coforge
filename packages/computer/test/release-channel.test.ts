import { expect, test } from "bun:test";

import { resolveReleaseFeedUrl, resolveServerUrl } from "../src/release-channel";

test("an unset feed URL falls back to the production default", () => {
  expect(resolveReleaseFeedUrl(undefined)).toBe("https://releases.coforge.cn/");
  expect(resolveReleaseFeedUrl("")).toBe("https://releases.coforge.cn/");
});

test("a configured feed URL is used as-is", () => {
  expect(resolveReleaseFeedUrl("https://releases.staging.coforge.cn/")).toBe(
    "https://releases.staging.coforge.cn/",
  );
});

test("official release feeds select the matching Web server", () => {
  expect(resolveServerUrl("https://releases.coforge.cn")).toBe("https://coforge.cn");
  expect(resolveServerUrl("https://releases.coforge.cn/")).toBe("https://coforge.cn");
  expect(resolveServerUrl("https://releases-staging.coforge.cn")).toBe(
    "https://staging.coforge.cn",
  );
  expect(resolveServerUrl("https://releases-staging.coforge.cn/")).toBe(
    "https://staging.coforge.cn",
  );
});

test("a compiled product rejects an unsupported release feed", () => {
  expect(() => resolveServerUrl("https://releases.example.com/")).toThrow(
    /does not identify an official CoForge build environment/,
  );
});

test("rejects a feed URL that is unusable rather than deferring the failure", () => {
  // The updater is constructed while commands are registered, so an unvalidated bad URL
  // surfaced as a bare TypeError from `login --help`, with nothing in CI to catch it.
  expect(() => resolveReleaseFeedUrl("not a url")).toThrow(/not a valid URL/);
  expect(() => resolveReleaseFeedUrl("http://releases.coforge.cn/")).toThrow(/must use HTTPS/);
});

test("the package build delegates environment selection to the release build owner", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const build: string = manifest.scripts.build;

  expect(build).toBe("bun ../../scripts/release/build-package.ts computer");
});
