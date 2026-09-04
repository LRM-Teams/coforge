/** Which release feed a build trusts is compiled in, not read at process start: staging and
 * production builds are different artifacts, and a runtime toggle would let a staging binary
 * (or an attacker) redirect a production install to an untrusted feed. `bun build --compile
 * --env=COFORGE_RELEASE_*` (see package.json's build script) inlines this `process.env` read
 * as a literal string at compile time, so the value below must stay a direct
 * `process.env.COFORGE_RELEASE_FEED_URL` member expression - reading through an indirection (a
 * variable, a parameter) defeats the inliner and turns this back into a runtime lookup.
 *
 * `--env` only inlines a variable that is actually set while building; one that is unset
 * stays a live runtime lookup in the compiled binary, which is why the build script exports
 * it as `"${VAR-}"`. An empty string still inlines, and the parser below treats it as absent. */

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

export const COFORGE_RELEASE_FEED_URL = resolveReleaseFeedUrl(process.env.COFORGE_RELEASE_FEED_URL);
