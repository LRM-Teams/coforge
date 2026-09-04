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
