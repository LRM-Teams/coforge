/**
 * How often a Windows Coordinator checks that each enabled Workspace child is still alive.
 * Linux/macOS rely on systemd/launchd `Restart`/`KeepAlive`; Windows has no OS unit, so the
 * Coordinator is the failure-restart agent.
 */
export const WINDOWS_WORKSPACE_RECONCILE_MS = 3_000;

export type WindowsWorkspaceReconcileLoop = {
  stop: () => void;
};

/**
 * Starts the Windows-only Workspace failure-restart poll. Returns null on other platforms so
 * callers can share one startup path. Errors from `reconcile` are reported and never throw out
 * of the timer (a degraded Workspace must not take down the Coordinator).
 */
export function startWindowsWorkspaceReconcileLoop(
  reconcile: () => Promise<void>,
  options: {
    platform?: NodeJS.Platform;
    intervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    onError?: (error: unknown) => void;
  } = {},
): WindowsWorkspaceReconcileLoop | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;
  const intervalMs = options.intervalMs ?? WINDOWS_WORKSPACE_RECONCILE_MS;
  const schedule = options.setIntervalFn ?? setInterval;
  const clear = options.clearIntervalFn ?? clearInterval;
  const onError = options.onError ?? (() => {});
  let inFlight = false;
  const timer = schedule(() => {
    if (inFlight) return;
    inFlight = true;
    void reconcile()
      .catch(onError)
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  return {
    stop: () => clear(timer),
  };
}
