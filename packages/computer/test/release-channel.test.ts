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

/** The trusted key set is checked in rather than held only in CI configuration, so that
 * changing who may sign a release is a reviewed commit with a history, not a settings edit.
 * These files are what the release workflow feeds to COFORGE_RELEASE_TRUSTED_KEYS, so a
 * malformed one must fail here rather than at build time. */
test.each(["staging", "production"])("the checked-in %s trust set parses", async (channel) => {
  const path = new URL(`../../../release/trusted-keys/${channel}.json`, import.meta.url);
  const raw = await Bun.file(path).text();

  // production is empty today, so assert the parse itself rather than looping over nothing.
  expect(() => parseReleaseTrustedKeys(raw)).not.toThrow();
  for (const keyId of Object.keys(parseReleaseTrustedKeys(raw))) {
    expect(keyId).toStartWith(`coforge-release-${channel === "production" ? "prod" : channel}`);
  }
});

test("the staging trust set carries exactly the provisioned key", async () => {
  const path = new URL("../../../release/trusted-keys/staging.json", import.meta.url);

  const keys = parseReleaseTrustedKeys(await Bun.file(path).text());

  expect(Object.keys(keys)).toEqual(["coforge-release-staging-1"]);
});

test("production has no signing key yet, so a production build trusts nothing", async () => {
  const path = new URL("../../../release/trusted-keys/production.json", import.meta.url);

  expect(parseReleaseTrustedKeys(await Bun.file(path).text())).toEqual({});
});

test("rejects a feed URL that is unusable rather than deferring the failure", () => {
  // The updater is constructed while commands are registered, so an unvalidated bad URL
  // surfaced as a bare TypeError from `login --help`, with nothing in CI to catch it.
  expect(() => resolveReleaseFeedUrl("not a url")).toThrow(/not a valid URL/);
  expect(() => resolveReleaseFeedUrl("http://releases.coforge.cn/")).toThrow(/must use HTTPS/);
});

test("rejects a trusted key the verifier could never use", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
    type: "spki",
    format: "pem",
  });
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({
    type: "spki",
    format: "pem",
  });

  for (const key of [rsa, p384]) {
    expect(() => parseReleaseTrustedKeys(JSON.stringify({ k: key }))).toThrow(
      /must be Ed25519 or ECDSA P-256/,
    );
  }
});

test("keeps a key id that collides with an Object prototype member", () => {
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });

  // Built as text: in an object literal `__proto__:` sets the prototype rather than an own
  // property, so JSON.stringify would never emit the key this test is about.
  const encoded = JSON.stringify(key);
  const parsed = parseReleaseTrustedKeys(`{"__proto__":${encoded},"constructor":${encoded}}`);

  expect(Object.keys(parsed).sort()).toEqual(["__proto__", "constructor"]);
});
