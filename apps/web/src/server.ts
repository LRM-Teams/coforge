import handler from "@tanstack/react-start/server-entry";

import { paraglideMiddleware } from "./paraglide/server";
import { assertStartupConfig } from "./server/startup-config.server";
import { startWeeklyReportScheduleTickFromEnv } from "./server/records/weekly-report-schedule-tick.server";

// Fail the boot, not the first request, on invalid deployment configuration.
assertStartupConfig();
// Optional in-process clock for weekly-report auto-send (ADR 0011). No-op unless
// COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS is set; external HTTP cron remains valid.
startWeeklyReportScheduleTickFromEnv();

export function isNonLocalizedRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/") ||
    // The two bootstrap installer entry points (`curl .../computer/install.sh | sh`,
    // `irm .../computer/install.ps1 | iex`) must resolve at exactly this path in every
    // environment (docs/release.md's "Local Computer distribution model"). Paraglide's
    // URL-pattern middleware otherwise 307-redirects any unprefixed path to `/en/...`, which
    // both breaks the documented URL and turns a `curl | sh` pipeline's error case into an
    // 18 KB HTML not-found page instead of plain text.
    pathname === "/computer/install.sh" ||
    pathname === "/computer/install.ps1"
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    return isNonLocalizedRequest(request)
      ? handler.fetch(request)
      : paraglideMiddleware(request, () => handler.fetch(request));
  },
};
