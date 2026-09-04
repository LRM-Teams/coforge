import { expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import {
  assertBootstrapManifest,
  BOOTSTRAP_MANIFEST_PATH,
  ReleaseEnvelopeError,
  verifyReleaseEnvelope,
  type BootstrapManifest,
} from "./release-envelope";

function envelope(keyId: string, payload: unknown, signPayload: (signed: Buffer) => Buffer) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const signed = Buffer.from(`coforge-release-v1\n${keyId}\n${encoded}`);
  const signature = signPayload(signed);
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      key_id: keyId,
      payload: encoded,
      signature: signature.toString("base64"),
    }),
  );
}

function tamperPayload(bytes: Uint8Array): Uint8Array {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  parsed.payload = Buffer.from(JSON.stringify({ tampered: true })).toString("base64");
  return Buffer.from(JSON.stringify(parsed));
}

function expectEnvelopeError(operation: () => unknown, code: "FEED_INVALID" | "INTEGRITY"): void {
  try {
    operation();
    throw new Error("expected verifyReleaseEnvelope to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseEnvelopeError);
    expect((error as ReleaseEnvelopeError).code).toBe(code);
  }
}

test("verifies an Ed25519-signed envelope and rejects a tampered payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = { hello: "ed25519" };
  const bytes = envelope("ed25519-key", payload, (signed) => sign(null, signed, privateKey));

  const result = verifyReleaseEnvelope<typeof payload>(bytes, { "ed25519-key": pem });
  expect(result.value).toEqual(payload);

  expectEnvelopeError(
    () => verifyReleaseEnvelope(tamperPayload(bytes), { "ed25519-key": pem }),
    "INTEGRITY",
  );
});

test("verifies a P-256 ECDSA-signed envelope and rejects a tampered payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = { hello: "p256" };
  const bytes = envelope("p256-key", payload, (signed) =>
    sign("sha256", signed, { key: privateKey, dsaEncoding: "der" }),
  );

  const result = verifyReleaseEnvelope<typeof payload>(bytes, { "p256-key": pem });
  expect(result.value).toEqual(payload);

  expectEnvelopeError(
    () => verifyReleaseEnvelope(tamperPayload(bytes), { "p256-key": pem }),
    "INTEGRITY",
  );
});

test("rejects an EC signature on a curve other than P-256", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "secp384r1",
  }) as { privateKey: KeyObject; publicKey: KeyObject };
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = { hello: "secp384r1" };
  const bytes = envelope("secp384-key", payload, (signed) =>
    sign("sha256", signed, { key: privateKey, dsaEncoding: "der" }),
  );

  expectEnvelopeError(() => verifyReleaseEnvelope(bytes, { "secp384-key": pem }), "INTEGRITY");
});

test("rejects an envelope signed by an untrusted key", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const payload = { hello: "world" };
  const bytes = envelope("unknown-key", payload, (signed) => sign(null, signed, privateKey));

  expectEnvelopeError(() => verifyReleaseEnvelope(bytes, {}), "INTEGRITY");
});

test("rejects a structurally invalid envelope", () => {
  expectEnvelopeError(() => verifyReleaseEnvelope(Buffer.from("not json"), {}), "FEED_INVALID");
  expectEnvelopeError(
    () => verifyReleaseEnvelope(Buffer.from(JSON.stringify({ schema_version: 2 })), {}),
    "FEED_INVALID",
  );
  expectEnvelopeError(
    () =>
      verifyReleaseEnvelope(
        Buffer.from(JSON.stringify({ schema_version: 1, key_id: "k", payload: "p" })),
        {},
      ),
    "FEED_INVALID",
  );
});

test("accepts a well-formed bootstrap manifest", () => {
  const manifest: BootstrapManifest = {
    schema_version: 1,
    targets: {
      "linux-x64": { size: 1024, sha256: "a".repeat(64) },
      "darwin-arm64": { size: 2048, sha256: "b".repeat(64) },
    },
  };

  expect(() => assertBootstrapManifest(manifest)).not.toThrow();
});

test("rejects an invalid bootstrap manifest", () => {
  expect(() => assertBootstrapManifest({ schema_version: 2, targets: {} })).toThrow();
  expect(() =>
    assertBootstrapManifest({
      schema_version: 1,
      targets: { "windows-x64": { size: 1, sha256: "a".repeat(64) } },
    }),
  ).toThrow();
  expect(() =>
    assertBootstrapManifest({
      schema_version: 1,
      targets: { "linux-x64": { size: -1, sha256: "a".repeat(64) } },
    }),
  ).toThrow();
  expect(() =>
    assertBootstrapManifest({
      schema_version: 1,
      targets: { "linux-x64": { size: 1, sha256: "not-a-digest" } },
    }),
  ).toThrow();
});

test("names the bootstrap manifest's fixed path", () => {
  expect(BOOTSTRAP_MANIFEST_PATH).toBe("bootstrap/v1/manifest.json");
});
