import { createPublicKey } from "node:crypto";

/** Which release feed a build trusts is compiled in, not read at process start: staging and
 * production builds are different artifacts, and a runtime toggle would let a staging binary
 * (or an attacker) redirect a production install to an untrusted feed. `bun build --compile
 * --env=COFORGE_RELEASE_*` (see package.json's build script) inlines these two `process.env`
 * reads as literal strings at compile time, so the values below must stay direct
 * `process.env.COFORGE_RELEASE_*` member expressions - reading through an indirection (a
 * variable, a parameter) defeats the inliner and turns this back into a runtime lookup. */

const DEFAULT_RELEASE_FEED_URL = "https://releases.coforge.cn/";

/** Missing config falls back to the production feed, since that is the safe default; an
 * empty string is treated the same as missing. */
export function resolveReleaseFeedUrl(raw: string | undefined): string {
  return raw && raw.length > 0 ? raw : DEFAULT_RELEASE_FEED_URL;
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
  const keys: Record<string, string> = {};
  for (const [keyId, pem] of Object.entries(parsed)) {
    if (keyId.length === 0) {
      throw new Error("COFORGE_RELEASE_TRUSTED_KEYS has an entry with an empty key_id");
    }
    if (typeof pem !== "string") {
      throw new Error(`COFORGE_RELEASE_TRUSTED_KEYS entry for "${keyId}" is not a string`);
    }
    try {
      createPublicKey(pem);
    } catch {
      throw new Error(`COFORGE_RELEASE_TRUSTED_KEYS entry for "${keyId}" is not a PEM public key`);
    }
    keys[keyId] = pem;
  }
  return keys;
}

export const COFORGE_RELEASE_FEED_URL = resolveReleaseFeedUrl(process.env.COFORGE_RELEASE_FEED_URL);
export const COFORGE_RELEASE_TRUSTED_KEYS = parseReleaseTrustedKeys(
  process.env.COFORGE_RELEASE_TRUSTED_KEYS,
);
