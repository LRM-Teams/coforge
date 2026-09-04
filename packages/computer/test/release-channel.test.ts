import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { parseReleaseTrustedKeys, resolveReleaseFeedUrl } from "../src/release-channel";

function pem(): string {
  return generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
}

test("an unset feed URL falls back to the production default", () => {
  expect(resolveReleaseFeedUrl(undefined)).toBe("https://releases.coforge.cn/");
  expect(resolveReleaseFeedUrl("")).toBe("https://releases.coforge.cn/");
});

test("a configured feed URL is used as-is", () => {
  expect(resolveReleaseFeedUrl("https://releases.staging.coforge.cn/")).toBe(
    "https://releases.staging.coforge.cn/",
  );
});

test("an unset trusted-key config fails closed to an empty trust set", () => {
  expect(parseReleaseTrustedKeys(undefined)).toEqual({});
  expect(parseReleaseTrustedKeys("")).toEqual({});
});

test("a valid trusted-key config parses multiple keys, as key rotation requires", () => {
  const first = pem();
  const second = pem();

  const keys = parseReleaseTrustedKeys(
    JSON.stringify({ "release-key-2026-a": first, "release-key-2026-b": second }),
  );

  expect(keys).toEqual({ "release-key-2026-a": first, "release-key-2026-b": second });
});

test("malformed JSON throws instead of silently producing an empty trust set", () => {
  expect(() => parseReleaseTrustedKeys("{not json")).toThrow();
});

test("a non-object trusted-key config throws", () => {
  expect(() => parseReleaseTrustedKeys("[]")).toThrow();
  expect(() => parseReleaseTrustedKeys('"a string"')).toThrow();
});

test("an empty key_id throws", () => {
  expect(() => parseReleaseTrustedKeys(JSON.stringify({ "": pem() }))).toThrow();
});

test("a value that is not a PEM public key throws", () => {
  expect(() =>
    parseReleaseTrustedKeys(JSON.stringify({ "release-key-2026-a": "not a pem" })),
  ).toThrow();
});

/** `bun build --env=PREFIX_*` inlines only variables that are set while building; an unset one
 * stays a runtime lookup, so a binary built without release config would honour whatever
 * COFORGE_RELEASE_TRUSTED_KEYS the environment happens to carry at install time. Exporting
 * both as "${VAR-}" makes the empty case inline too. */
test("the build script always sets the release variables so they inline", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const build: string = manifest.scripts.build;

  expect(build).toContain('COFORGE_RELEASE_FEED_URL="${COFORGE_RELEASE_FEED_URL-}"');
  expect(build).toContain('COFORGE_RELEASE_TRUSTED_KEYS="${COFORGE_RELEASE_TRUSTED_KEYS-}"');
  expect(build.indexOf("COFORGE_RELEASE_TRUSTED_KEYS=")).toBeLessThan(build.indexOf("bun build"));
  expect(build).toContain("--env=COFORGE_RELEASE_*");
});
