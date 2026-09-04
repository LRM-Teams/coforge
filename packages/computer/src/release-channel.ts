import { createPublicKey } from "node:crypto";

/** Which release feed a build trusts is compiled in, not read at process start: staging and
 * production builds are different artifacts, and a runtime toggle would let a staging binary
 * (or an attacker) redirect a production install to an untrusted feed. `bun build --compile
 * --env=COFORGE_RELEASE_*` (see package.json's build script) inlines these two `process.env`
 * reads as literal strings at compile time, so the values below must stay direct
 * `process.env.COFORGE_RELEASE_*` member expressions - reading through an indirection (a
 * variable, a parameter) defeats the inliner and turns this back into a runtime lookup.
 *
 * `--env` only inlines a variable that is actually set while building; one that is unset
 * stays a live runtime lookup in the compiled binary, which is why the build script exports
 * both as `"${VAR-}"`. An empty string still inlines, and both parsers treat it as absent. */

const DEFAULT_RELEASE_FEED_URL = "https://releases.coforge.cn/";

/** Missing config falls back to the production feed, since that is the safe default; an
 * empty string is treated the same as missing. A value that is present but unusable throws
 * at load: the updater is constructed while commands are registered, so an unvalidated bad
 * URL surfaces as a bare TypeError from an unrelated command like `login --help`, long after
 * the build that could have caught it. */
export function resolveReleaseFeedUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_RELEASE_FEED_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`COFORGE_RELEASE_FEED_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`COFORGE_RELEASE_FEED_URL must use HTTPS: ${raw}`);
  }
  return raw;
}

/** Missing config fails closed to an empty trust set (no key is trusted, so every signed
 * document is rejected) rather than falling back to any hardcoded key. A config value that
 * is present but malformed throws instead, so a broken build fails loudly at load time
 * rather than silently shipping with no trusted keys. */
export function parseReleaseTrustedKeys(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`COFORGE_RELEASE_TRUSTED_KEYS is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "COFORGE_RELEASE_TRUSTED_KEYS must be a JSON object mapping key_id to a PEM public key",
    );
  }
  const keys: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [keyId, pem] of Object.entries(parsed)) {
    if (keyId.length === 0) {
      throw new Error("COFORGE_RELEASE_TRUSTED_KEYS has an entry with an empty key_id");
    }
    if (typeof pem !== "string") {
      throw new Error(`COFORGE_RELEASE_TRUSTED_KEYS entry for "${keyId}" is not a string`);
    }
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey(pem);
    } catch {
      throw new Error(`COFORGE_RELEASE_TRUSTED_KEYS entry for "${keyId}" is not a PEM public key`);
    }
    // Reject an unverifiable algorithm here rather than on every signature check, so a build
    // configured with a key the verifier cannot use fails loudly instead of trusting nothing.
    const curve = publicKey.asymmetricKeyDetails?.namedCurve;
    const usable =
      publicKey.asymmetricKeyType === "ed25519" ||
      (publicKey.asymmetricKeyType === "ec" && curve === "prime256v1");
    if (!usable) {
      throw new Error(
        `COFORGE_RELEASE_TRUSTED_KEYS entry for "${keyId}" must be Ed25519 or ECDSA P-256`,
      );
    }
    keys[keyId] = pem;
  }
  return keys;
}

export const COFORGE_RELEASE_FEED_URL = resolveReleaseFeedUrl(process.env.COFORGE_RELEASE_FEED_URL);
export const COFORGE_RELEASE_TRUSTED_KEYS = parseReleaseTrustedKeys(
  process.env.COFORGE_RELEASE_TRUSTED_KEYS,
);
