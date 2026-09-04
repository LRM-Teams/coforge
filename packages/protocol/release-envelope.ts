import { createPublicKey, verify, type KeyObject } from "node:crypto";

/** Wire format shared by every signed release document, regardless of tier
 * (channels, release sets, component manifests, installation bundles). */
export type SignedEnvelope = {
  schema_version: 1;
  key_id: string;
  payload: string;
  signature: string;
};

export class ReleaseEnvelopeError extends Error {
  constructor(
    readonly code: "FEED_INVALID" | "INTEGRITY",
    message: string,
  ) {
    super(message);
    this.name = "ReleaseEnvelopeError";
  }
}

function feedInvalid(message: string): ReleaseEnvelopeError {
  return new ReleaseEnvelopeError("FEED_INVALID", message);
}

function integrity(message: string): ReleaseEnvelopeError {
  return new ReleaseEnvelopeError("INTEGRITY", message);
}

/** Verifies a signed release document against the caller's trusted key set and returns
 * both its decoded payload and the raw payload bytes (callers that address a document by
 * its own digest, such as a release set's sha256 selector, hash the raw bytes, not the
 * re-serialized value). */
export function verifyReleaseEnvelope<T>(
  bytes: Uint8Array,
  trustedKeys: Record<string, string>,
): { value: T; payloadBytes: Uint8Array } {
  let envelope: SignedEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes)) as SignedEnvelope;
  } catch {
    throw feedInvalid("signed document is not valid JSON");
  }
  if (
    envelope?.schema_version !== 1 ||
    typeof envelope.key_id !== "string" ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string"
  ) {
    throw feedInvalid("signed document envelope is invalid");
  }
  const key = trustedKeys[envelope.key_id];
  if (!key) throw integrity(`untrusted signing key: ${envelope.key_id}`);
  const signed = Buffer.from(`coforge-release-v1\n${envelope.key_id}\n${envelope.payload}`);
  const signature = Buffer.from(envelope.signature, "base64");
  let valid = false;
  try {
    valid = verifySignature(createPublicKey(key), signed, signature);
  } catch (error) {
    if (error instanceof ReleaseEnvelopeError) throw error;
    throw integrity("signed document signature is malformed");
  }
  if (!valid) throw integrity("signed document signature is invalid");
  const payloadBytes = Buffer.from(envelope.payload, "base64");
  try {
    return { value: JSON.parse(payloadBytes.toString("utf8")) as T, payloadBytes };
  } catch {
    throw feedInvalid("signed payload is not valid JSON");
  }
}

/** Dispatches by key type because a KMS-backed signer may be Ed25519 today and ECDSA P-256
 * tomorrow (Aliyun KMS asymmetric keys support RSA/ECC_P256/SM2, not Ed25519); the verifier
 * ships inside every installed binary, so it must already recognize P-256 before any such
 * key is issued. Any other key type, including a non-P-256 EC curve, is rejected rather than
 * silently accepted. */
function verifySignature(publicKey: KeyObject, signed: Buffer, signature: Buffer): boolean {
  const keyType = publicKey.asymmetricKeyType;
  if (keyType === "ed25519") {
    return verify(null, signed, publicKey, signature);
  }
  if (keyType === "ec") {
    const curve = publicKey.asymmetricKeyDetails?.namedCurve;
    if (curve !== "prime256v1") {
      throw integrity(`unsupported EC curve: ${curve ?? "unknown"}`);
    }
    // dsaEncoding is explicit so the envelope contract is unambiguous: Aliyun KMS's
    // ECDSA_SHA_256 signing algorithm returns DER-encoded signatures.
    return verify("sha256", signed, { key: publicKey, dsaEncoding: "der" }, signature);
  }
  throw integrity(`unsupported signing key type: ${keyType ?? "unknown"}`);
}

/** Both installers pin a bootstrap digest per target: install.sh covers the POSIX four and
 * install.ps1 the two Windows ones, whose binary carries a .exe suffix. */
const BOOTSTRAP_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
] as const;
const BOOTSTRAP_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The bootstrap tier is addressed by a fixed mutable path rather than a release-set
 * digest, because install.sh must resolve it before it can verify anything. */
export type BootstrapManifest = {
  schema_version: 1;
  targets: Record<string, { size: number; sha256: string }>;
};

export const BOOTSTRAP_MANIFEST_PATH = "bootstrap/v1/manifest.json";

export function assertBootstrapManifest(value: unknown): asserts value is BootstrapManifest {
  const candidate = value as BootstrapManifest | undefined;
  if (
    candidate?.schema_version !== 1 ||
    typeof candidate.targets !== "object" ||
    candidate.targets === null
  ) {
    throw feedInvalid("bootstrap manifest schema is invalid");
  }
  for (const [target, identity] of Object.entries(candidate.targets)) {
    if (!(BOOTSTRAP_TARGETS as readonly string[]).includes(target)) {
      throw feedInvalid(`bootstrap manifest names an unsupported target: ${target}`);
    }
    if (
      typeof identity?.size !== "number" ||
      !Number.isSafeInteger(identity.size) ||
      identity.size < 0 ||
      typeof identity.sha256 !== "string" ||
      !BOOTSTRAP_SHA256_PATTERN.test(identity.sha256)
    ) {
      throw feedInvalid(`bootstrap manifest entry for ${target} is invalid`);
    }
  }
}
