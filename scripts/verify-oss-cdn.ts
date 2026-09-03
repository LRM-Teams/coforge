export interface ContentProbe {
  origin_url: string;
  cdn_url: string;
  expected_sha256: string;
}

export interface FilesProbe extends ContentProbe {
  unsigned_cdn_url: string;
}

export interface RejectedProbe {
  name: string;
  url: string;
}

export interface AcceptanceInput {
  files_host: string;
  releases_host: string;
  files: FilesProbe;
  release: ContentProbe;
  channels: ContentProbe;
  rejected_urls: RejectedProbe[];
}

export interface AcceptanceCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface AcceptanceReport {
  passed: boolean;
  checks: AcceptanceCheck[];
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CapturedResponse {
  status: number;
  headers: Headers;
  sha256?: string;
}

const PROBE_COOKIE = "coforge_acceptance_probe=must-not-authorize";
const MIN_IMMUTABLE_TTL_SECONDS = 30 * 24 * 60 * 60;
// Each delivery domain fronts exactly one private bucket, so the boundary is
// proven by asking one domain for the other domain's object key.
const REQUIRED_REJECTION_NAMES = new Set(["files-through-releases", "release-through-files"]);

function addCheck(checks: AcceptanceCheck[], id: string, passed: boolean, detail: string): void {
  checks.push({ id, passed, detail });
}

function isCdnUrl(value: string, hosts: string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && hosts.includes(url.hostname);
  } catch {
    return false;
  }
}

function isOriginUrl(value: string, cdnHosts: string[]): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !cdnHosts.includes(url.hostname) &&
      url.hostname.endsWith(".aliyuncs.com")
    );
  } catch {
    return false;
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isContentProbe(value: unknown): value is ContentProbe {
  if (typeof value !== "object" || value === null) return false;
  const probe = value as Record<string, unknown>;
  return (
    isString(probe.origin_url) &&
    isString(probe.cdn_url) &&
    isString(probe.expected_sha256) &&
    /^[a-f0-9]{64}$/.test(probe.expected_sha256)
  );
}

function isAcceptanceInput(value: unknown): value is AcceptanceInput {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  if (
    input.files_host !== "files.coforge.cn" ||
    input.releases_host !== "releases.coforge.cn" ||
    !isContentProbe(input.files) ||
    !isString((input.files as Record<string, unknown>).unsigned_cdn_url) ||
    !isContentProbe(input.release) ||
    !isContentProbe(input.channels) ||
    !Array.isArray(input.rejected_urls) ||
    input.rejected_urls.length !== REQUIRED_REJECTION_NAMES.size
  ) {
    return false;
  }

  const files = input.files as unknown as FilesProbe;
  const release = input.release as ContentProbe;
  const channels = input.channels as ContentProbe;
  const rejected = input.rejected_urls as unknown[];
  if (
    !rejected.every(
      (probe): probe is RejectedProbe =>
        typeof probe === "object" &&
        probe !== null &&
        isString((probe as Record<string, unknown>).name) &&
        isString((probe as Record<string, unknown>).url),
    )
  ) {
    return false;
  }

  try {
    const filesOrigin = new URL(files.origin_url);
    const filesCdn = new URL(files.cdn_url);
    const filesUnsigned = new URL(files.unsigned_cdn_url);
    const releaseOrigin = new URL(release.origin_url);
    const releaseCdn = new URL(release.cdn_url);
    const channelsOrigin = new URL(channels.origin_url);
    const channelsCdn = new URL(channels.cdn_url);
    const rejectedByName = new Map(rejected.map((probe) => [probe.name, new URL(probe.url)]));
    const filesThroughReleases = rejectedByName.get("files-through-releases");
    const releaseThroughFiles = rejectedByName.get("release-through-files");

    return (
      rejectedByName.size === REQUIRED_REJECTION_NAMES.size &&
      [...rejectedByName.keys()].every((name) => REQUIRED_REJECTION_NAMES.has(name)) &&
      filesOrigin.hostname !== releaseOrigin.hostname &&
      releaseOrigin.hostname === channelsOrigin.hostname &&
      filesCdn.origin === filesUnsigned.origin &&
      filesCdn.pathname === filesUnsigned.pathname &&
      filesCdn.search.length > 0 &&
      filesUnsigned.search.length === 0 &&
      // Each domain maps to its bucket one to one; no business prefix is
      // rewritten away, so a path can never be routed to the other bucket.
      filesCdn.hostname === input.files_host &&
      filesCdn.pathname === filesOrigin.pathname &&
      releaseCdn.hostname === input.releases_host &&
      releaseCdn.pathname === releaseOrigin.pathname &&
      channelsCdn.hostname === input.releases_host &&
      channelsCdn.pathname === channelsOrigin.pathname &&
      releaseCdn.search.length === 0 &&
      channelsCdn.search.length === 0 &&
      // The attachment key asked of the release domain, unsigned because that
      // domain has no signing to satisfy: only bucket isolation can reject it.
      filesThroughReleases?.hostname === input.releases_host &&
      filesThroughReleases.pathname === filesOrigin.pathname &&
      filesThroughReleases.search.length === 0 &&
      // The release key asked of the attachment domain, carrying valid signing
      // material so the rejection proves isolation rather than a missing
      // signature.
      releaseThroughFiles?.hostname === input.files_host &&
      releaseThroughFiles.pathname === releaseOrigin.pathname &&
      releaseThroughFiles.search.length > 0
    );
  } catch {
    return false;
  }
}

async function hashBody(response: Response): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  }
  return hasher.digest("hex");
}

async function capture(
  fetcher: Fetcher,
  url: string,
  includeBody: boolean,
): Promise<CapturedResponse> {
  const response = await fetcher(url, {
    headers: { Cookie: PROBE_COOKIE },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const captured: CapturedResponse = {
    status: response.status,
    headers: new Headers(response.headers),
  };
  if (includeBody) {
    captured.sha256 = await hashBody(response);
  } else {
    await response.body?.cancel();
  }
  return captured;
}

function hasNoProviderLeak(response: CapturedResponse, originHosts: string[]): boolean {
  if (response.headers.has("location") || response.headers.has("set-cookie")) {
    return false;
  }
  const values = [...response.headers.values()].join("\n").toLowerCase();
  return !originHosts.some((host) => values.includes(host.toLowerCase()));
}

function hasFilesCachePolicy(headers: Headers): boolean {
  const value = headers.get("cache-control")?.toLowerCase() ?? "";
  return value.includes("private") && value.includes("no-store");
}

function hasReleaseCachePolicy(headers: Headers): boolean {
  const value = headers.get("cache-control")?.toLowerCase() ?? "";
  const maxAge = /(?:^|,)\s*max-age=(\d+)(?:\s*,|$)/.exec(value)?.[1];
  return (
    value.includes("public") &&
    value.includes("immutable") &&
    maxAge !== undefined &&
    Number(maxAge) >= MIN_IMMUTABLE_TTL_SECONDS
  );
}

function hasChannelsCachePolicy(headers: Headers): boolean {
  const value = headers.get("cache-control")?.toLowerCase() ?? "";
  return value.includes("no-cache") && value.includes("must-revalidate");
}

export async function runAcceptance(
  input: AcceptanceInput,
  fetcher: Fetcher = fetch,
): Promise<AcceptanceReport> {
  if (!isAcceptanceInput(input)) {
    return {
      passed: false,
      checks: [
        {
          id: "input_contract",
          passed: false,
          detail: "acceptance input is incomplete or outside the approved scope",
        },
      ],
    };
  }

  const checks: AcceptanceCheck[] = [];
  const allCdnUrls = [
    input.files.cdn_url,
    input.files.unsigned_cdn_url,
    input.release.cdn_url,
    input.channels.cdn_url,
    ...input.rejected_urls.map(({ url }) => url),
  ];
  const origins = [input.files.origin_url, input.release.origin_url, input.channels.origin_url];
  const originHosts = origins.map((url) => new URL(url).hostname);
  const cdnHosts = [input.files_host, input.releases_host];

  addCheck(
    checks,
    "input_urls_are_scoped",
    isCdnUrl(input.files.cdn_url, [input.files_host]) &&
      isCdnUrl(input.files.unsigned_cdn_url, [input.files_host]) &&
      isCdnUrl(input.release.cdn_url, [input.releases_host]) &&
      isCdnUrl(input.channels.cdn_url, [input.releases_host]) &&
      allCdnUrls.every((url) => isCdnUrl(url, cdnHosts)) &&
      origins.every((url) => isOriginUrl(url, cdnHosts)),
    "all probes use the expected HTTPS delivery domains and OSS host classes",
  );

  try {
    const filesOrigin = await capture(fetcher, input.files.origin_url, false);
    const releaseOrigin = await capture(fetcher, input.release.origin_url, false);
    const channelsOrigin = await capture(fetcher, input.channels.origin_url, false);
    addCheck(
      checks,
      "origins_reject_anonymous_exact_key_get",
      [filesOrigin, releaseOrigin, channelsOrigin].every(({ status }) => status === 403),
      "every known existing OSS object returned HTTP 403 without a signature",
    );

    const unsignedFiles = await capture(fetcher, input.files.unsigned_cdn_url, false);
    addCheck(
      checks,
      "files_require_cdn_signature",
      unsignedFiles.status === 403,
      "the attachment path returned HTTP 403 without CDN signing material",
    );

    const filesCdn = await capture(fetcher, input.files.cdn_url, true);
    const releaseCdn = await capture(fetcher, input.release.cdn_url, true);
    const channelsCdn = await capture(fetcher, input.channels.cdn_url, true);

    addCheck(
      checks,
      "cdn_private_origin_bytes_match",
      filesCdn.status === 200 &&
        releaseCdn.status === 200 &&
        channelsCdn.status === 200 &&
        filesCdn.sha256 === input.files.expected_sha256 &&
        releaseCdn.sha256 === input.release.expected_sha256 &&
        channelsCdn.sha256 === input.channels.expected_sha256,
      "all CDN responses returned the expected SHA-256 bytes",
    );
    addCheck(
      checks,
      "files_client_cache_is_private",
      hasFilesCachePolicy(filesCdn.headers),
      "the attachment response is marked private and no-store",
    );
    addCheck(
      checks,
      "release_is_immutable_long_cached",
      hasReleaseCachePolicy(releaseCdn.headers),
      "the immutable release response is public, immutable, and cached for at least 30 days",
    );
    addCheck(
      checks,
      "channels_revalidate",
      hasChannelsCachePolicy(channelsCdn.headers),
      "channels.json requires cache revalidation",
    );
    addCheck(
      checks,
      "cdn_responses_hide_provider",
      [filesCdn, releaseCdn, channelsCdn].every((response) =>
        hasNoProviderLeak(response, originHosts),
      ),
      "successful client responses contain no redirect, Set-Cookie, or OSS hostname",
    );

    for (const rejected of input.rejected_urls) {
      const response = await capture(fetcher, rejected.url, false);
      addCheck(
        checks,
        `route_rejected:${rejected.name}`,
        response.status >= 400 && response.status < 500 && !response.headers.has("location"),
        "the boundary probe returned a non-redirecting 4xx response",
      );
    }
  } catch {
    addCheck(
      checks,
      "probe_execution",
      false,
      "a probe could not complete; inspect operator-side diagnostics",
    );
  }

  return {
    passed: checks.every(({ passed }) => passed),
    checks,
  };
}

function cliFailure(id: string, detail: string): AcceptanceReport {
  return {
    passed: false,
    checks: [{ id, passed: false, detail }],
  };
}

async function readCliInput(args: string[]): Promise<unknown> {
  if (args.length !== 2 || args[0] !== "--input") {
    throw new Error("usage");
  }
  const raw = args[1] === "-" ? await Bun.stdin.text() : await Bun.file(args[1]).text();
  return JSON.parse(raw) as unknown;
}

export async function runCli(args: string[]): Promise<number> {
  let report: AcceptanceReport;
  try {
    const input = await readCliInput(args);
    report = await runAcceptance(input as AcceptanceInput);
  } catch {
    report = cliFailure(
      "input_contract",
      "acceptance input is incomplete or outside the approved scope",
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.passed ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
