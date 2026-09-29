import { AsyncLocalStorage } from "node:async_hooks";
import { configure, withConfig, type LogRecord } from "@logtape/logtape";

// `withConfig` needs a process-global configuration that owns a context-local storage; it routes
// nothing itself. Importing this module installs it once, and no test configures, resets, or
// disposes LogTape afterwards: `configure` and `reset` throw while any scoped configuration is
// active, so one test that still does would fail whenever an earlier test's capture is running.
await configure({
  reset: true,
  sinks: {},
  loggers: [{ category: ["logtape", "meta"], lowestLevel: "error" }],
  contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
});

/**
 * Runs `run` with a sink that captures `coforge.daemon.*` records (and LogTape meta errors) from
 * `run` and the async work it starts, and from nowhere else. `run` sees the records as they
 * arrive, so it can wait for one.
 *
 * The capture belongs to `run`'s async context (LogTape scoped configuration, 2.3.0+), so a test
 * that times out cannot disturb its successor: the abandoned `run` keeps logging into its own
 * records, and its capture ends without touching any other configuration.
 */
export async function captureDaemonLogs<T>(
  run: (records: readonly LogRecord[]) => Promise<T>,
): Promise<{ result: T; records: LogRecord[] }> {
  const records: LogRecord[] = [];
  const result = await withConfig(
    {
      sinks: { capture: (record) => void records.push(record) },
      loggers: [
        { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["capture"] },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["capture"] },
      ],
    },
    () => run(records),
  );
  return { result, records };
}
