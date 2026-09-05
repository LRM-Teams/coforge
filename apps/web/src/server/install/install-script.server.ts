import installShSource from "../../../../../scripts/release/install.sh?raw";
import installPs1Source from "../../../../../scripts/release/install.ps1?raw";

/**
 * Serves the two bootstrap installer scripts (`curl ... | sh`, `irm ... | iex`) at
 * `/computer/install.sh` and `/computer/install.ps1`, with one line rewritten: the release feed
 * the script downloads from.
 *
 * `docs/release.md` ("Local Computer distribution model"): each deployment serves its own pair of
 * entry points routed to the release feed that deployment trusts, because a `curl ... | sh` taken
 * from staging must install the staging build and not the production one. The scripts themselves
 * hardcode the production feed as their default - correct for `releases.coforge.cn`, wrong for
 * every other deployment - so the value is substituted per deployment here rather than left to
 * the user to remember to `export COFORGE_RELEASE_FEED_URL` before piping into a shell.
 *
 * The bytes are embedded at build time via Vite's `?raw` import, not read from disk at request
 * time, for two reasons:
 * - `apps/web/Dockerfile`'s production image only ships the built `.output` directory (plus the
 *   Prisma migration stage); the repository's `scripts/` directory does not exist inside the
 *   running container, so a runtime `readFile` would fail there even though it works locally.
 * - The script content is static regardless of which Computer/Daemon release version is
 *   currently `latest` (ADR 0007: integrity is checksum-based, not a signed per-version
 *   envelope) - publishing a new release must never require redeploying the web app just to
 *   keep serving these two files. Embedding at build time means these routes only change when
 *   `scripts/release/install.sh`/`install.ps1` themselves change, which already requires a web
 *   rebuild for the Dockerfile's `COPY scripts/release scripts/release` step to pick up.
 *
 * A `curl | sh` invocation runs whatever body comes back with no HTML/JSON parsing. So there is
 * no such thing as a harmless error body here: when the feed is not configured these routes
 * answer 503 - which makes `curl -fsSL` fail before anything reaches the shell - with a body that
 * is still only comment lines if someone pipes it anyway. What must never happen is a 200
 * carrying the wrong feed.
 */

/** The value `scripts/release/install.sh` and `install.ps1` carry as their own default. */
const PRODUCTION_FEED_URL = "https://releases.coforge.cn";

/** The exact source line each script uses to seed its feed URL. Substitution matches these
 * literally and fails when the count is not exactly one, so that a rewording of either script
 * breaks loudly here instead of silently serving the production feed from staging. */
const SH_DEFAULT_FEED_LINE = `default_feed_url="${PRODUCTION_FEED_URL}"`;
const PS1_DEFAULT_FEED_LINE = `$defaultFeedUrl = "${PRODUCTION_FEED_URL}"`;

/** Accepts only what can be embedded in a shell double-quoted string and a PowerShell
 * double-quoted string with no metacharacter of either language surviving: no `$`, backtick,
 * quote, backslash, whitespace, `;` or `&`. The value is operator-set rather than user-set, but
 * it is being written into a payload that a shell will execute. */
const FEED_URL_CHARACTERS = /^[A-Za-z0-9.:/_-]+$/;

export function isValidReleaseFeedUrl(value: string): boolean {
  if (!FEED_URL_CHARACTERS.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.hostname !== "" &&
    // Requiring the value to be exactly scheme + host rules out a path (the scripts append their
    // own) and a trailing slash (which would produce `https://host//latest`) in one comparison.
    value === `${url.protocol}//${url.host}`
  );
}

/** This deployment's feed URL, or null when it is unset or unusable. */
export function resolveReleaseFeedUrl(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const configured = environment.COFORGE_RELEASE_FEED_URL?.trim();
  if (!configured) return null;
  return isValidReleaseFeedUrl(configured) ? configured : null;
}

/** Replaces the script's own default feed URL with this deployment's. Throws unless the anchor
 * line is present exactly once - see SH_DEFAULT_FEED_LINE. */
export function withDeploymentFeedUrl(source: string, anchor: string, feedUrl: string): string {
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Installer script must contain exactly one \`${anchor}\` to rewrite, found ${occurrences}`,
    );
  }
  return source.replace(anchor, anchor.replace(PRODUCTION_FEED_URL, feedUrl));
}

function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // These are bootstrap entry points: a stale copy held by an intermediary is how a user ends
      // up installing from a feed this deployment no longer uses.
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function unconfiguredResponse(): Response {
  return new Response(
    "# COFORGE_RELEASE_FEED_URL is not configured for this deployment, so there is no release\n" +
      "# feed to install from. This is a server misconfiguration - see infra/staging/README.md.\n",
    {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

function installScriptResponse(
  source: string,
  anchor: string,
  environment?: Record<string, string | undefined>,
): Response {
  const feedUrl = resolveReleaseFeedUrl(environment);
  if (feedUrl === null) return unconfiguredResponse();
  return textResponse(withDeploymentFeedUrl(source, anchor, feedUrl));
}

export function installShHandler(environment?: Record<string, string | undefined>): Response {
  return installScriptResponse(installShSource, SH_DEFAULT_FEED_LINE, environment);
}

export function installPs1Handler(environment?: Record<string, string | undefined>): Response {
  return installScriptResponse(installPs1Source, PS1_DEFAULT_FEED_LINE, environment);
}
