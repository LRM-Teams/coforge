/** Read-only probe of the Windows Coordinator Scheduled Task (`WindowsUserDaemonHost`).
 * Task presence comes from `schtasks /Query`; "running" is inferred from the Status line
 * (English `Running` or common localized forms). PID comes from an injected resolver —
 * typically the live `supervisor.lock` owner — because Scheduled Tasks do not expose a PID. */

export type WindowsTaskQueryResult = { loaded: boolean; running: boolean };

export type ProbeWindowsCoordinatorOptions = {
  /** Injectable `schtasks /Query` seam for tests. */
  query?: (taskName: string) => Promise<{ code: number; stdout: string }>;
  /** Resolves the Coordinator PID when the task appears to be running. */
  resolvePid?: () => Promise<number | null>;
};

const RUNNING_STATUS =
  /^(?:status|状态)\s*:\s*(?:running|正在运行|実行中|en cours d'exécution|wird ausgeführt)\s*$/i;

/**
 * Interprets `schtasks /Query /TN … /FO LIST /V` stdout. `loaded` is always true here —
 * callers that already saw a non-zero Query exit must not call this.
 */
export function parseWindowsTaskQuery(stdout: string): WindowsTaskQueryResult {
  for (const raw of stdout.split(/\r?\n/)) {
    if (RUNNING_STATUS.test(raw.trim())) return { loaded: true, running: true };
  }
  return { loaded: true, running: false };
}

export async function probeWindowsCoordinator(
  taskName: string,
  options: ProbeWindowsCoordinatorOptions = {},
): Promise<{ loaded: boolean; pid: number | null }> {
  const query = options.query ?? queryWindowsTask;
  const resolvePid = options.resolvePid ?? (async () => null);
  const result = await query(taskName);
  if (result.code !== 0) return { loaded: false, pid: null };
  const parsed = parseWindowsTaskQuery(result.stdout);
  if (!parsed.running) return { loaded: true, pid: null };
  const pid = await resolvePid();
  return { loaded: true, pid: pid !== null && pid > 0 ? pid : null };
}

async function queryWindowsTask(taskName: string): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(["schtasks.exe", "/Query", "/TN", taskName, "/FO", "LIST", "/V"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, stdout };
}
