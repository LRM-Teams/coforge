import { getDatabaseClient } from "#src/server/db/client.server";
import { recordCatalog } from "./record-catalog.server";

export const WEEKLY_REPORT_SCHEDULE_TICK_ENV = "COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS";

/**
 * Optional in-process clock for ADR 0011 scheduled send. When set to a positive
 * millisecond interval, the web process periodically runs the same due-send path
 * as `POST /api/internal/weekly-report-schedule`. Leave unset in deployments that
 * already use an external cron against that HTTP endpoint.
 */
export function readWeeklyReportScheduleTickMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[WEEKLY_REPORT_SCHEDULE_TICK_ENV]?.trim();
  if (!raw) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(raw)) {
    throw new Error(
      `${WEEKLY_REPORT_SCHEDULE_TICK_ENV} must be a positive integer millisecond interval`,
    );
  }
  return Number(raw);
}

export type WeeklyReportScheduleTickDeps = {
  intervalMs: number;
  runDue: () => Promise<unknown>;
  /** Test seam: defaults to global `setInterval`. */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  log?: (event: Record<string, unknown>) => void;
};

/**
 * Starts a non-overlapping interval that invokes `runDue`. Overlapping ticks are
 * skipped while a previous run is still in flight.
 */
export function startWeeklyReportScheduleTick(deps: WeeklyReportScheduleTickDeps): {
  stop: () => void;
} {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const log = deps.log ?? ((event) => console.info(JSON.stringify(event)));
  let inFlight = false;

  const tick = () => {
    if (inFlight) {
      log({ event: "weekly_report_schedule_tick_skipped", reason: "in_flight" });
      return;
    }
    inFlight = true;
    void deps
      .runDue()
      .then((result) => {
        log({ event: "weekly_report_schedule_tick", result });
      })
      .catch((error: unknown) => {
        log({
          event: "weekly_report_schedule_tick_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const handle = setIntervalFn(tick, deps.intervalMs);
  log({ event: "weekly_report_schedule_tick_started", interval_ms: deps.intervalMs });
  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}

/** Boot hook: no-op when the env interval is unset. */
export function startWeeklyReportScheduleTickFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { stop: () => void } | undefined {
  const intervalMs = readWeeklyReportScheduleTickMs(env);
  if (intervalMs === undefined) return undefined;

  return startWeeklyReportScheduleTick({
    intervalMs,
    runDue: async () => {
      const db = getDatabaseClient();
      if (!db) return { error: "database unavailable" };
      return recordCatalog(db).runDueScheduledWeeklyAssignments();
    },
  });
}
