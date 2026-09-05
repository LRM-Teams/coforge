import installShSource from "../../../../../scripts/release/install.sh?raw";
import installPs1Source from "../../../../../scripts/release/install.ps1?raw";

/**
 * Serves the two bootstrap installer scripts (`curl ... | sh`, `irm ... | iex`) verbatim, at
 * `/computer/install.sh` and `/computer/install.ps1`.
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
 * A `curl | sh` invocation runs whatever body comes back with no HTML/JSON parsing, so an error
 * page here would be at best inert extra bytes and at worst literal shell/PowerShell syntax -
 * these responses are always successful, static text.
 */
function textResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function installShHandler(): Response {
  return textResponse(installShSource);
}

export function installPs1Handler(): Response {
  return textResponse(installPs1Source);
}
