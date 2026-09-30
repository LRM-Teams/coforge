/** Release and package builds both replace the direct
 * `process.env.COFORGE_RELEASE_FEED_URL` expression through Bun.build's `define`.
 * Keep that read direct so it cannot become a runtime override. The build scripts
 * resolve even an unset feed before compilation and derive the bundled Daemon's
 * server from the same mapping below. */

export const DEFAULT_RELEASE_FEED_URL = "https://releases.coforge.cn/";

/** The official build environments: a release feed (without a trailing slash) and the Web server
 * its builds talk to. The installer compiles in one of these feeds too; see
 * crates/installer/contract/feed-environments.json. */
export const OFFICIAL_RELEASE_ENVIRONMENTS = [
  { feed: "https://releases.coforge.cn", server: "https://coforge.cn" },
  { feed: "https://releases-staging.coforge.cn", server: "https://staging.coforge.cn" },
] as const;

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

/** A release feed and Web server are one compiled environment. Keep this mapping deliberately
 * closed: accepting an arbitrary valid feed would make an unofficial build look like an official
 * product while its authentication and Daemon traffic target an unrelated environment. */
export function resolveServerUrl(releaseFeedUrl: string): string {
  const feed = releaseFeedUrl.endsWith("/") ? releaseFeedUrl.slice(0, -1) : releaseFeedUrl;
  const environment = OFFICIAL_RELEASE_ENVIRONMENTS.find((candidate) => candidate.feed === feed);
  if (environment) return environment.server;
  throw new Error(
    `COFORGE_RELEASE_FEED_URL does not identify an official CoForge build environment: ${releaseFeedUrl}`,
  );
}

export const COFORGE_SERVER_URL = resolveServerUrl(COFORGE_RELEASE_FEED_URL);
