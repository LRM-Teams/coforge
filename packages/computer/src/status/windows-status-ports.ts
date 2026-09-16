/** Best-effort, unverified: no Windows machine exercised this. `WindowsUserDaemonHost`
 * (packages/daemon/src/daemon-host/windows-task.ts) registers the Coordinator as a Scheduled
 * Task named "CoForge Daemon"; `schtasks /Query` is the read-only way to ask whether it exists
 * and whether it is currently running. Scheduled Tasks do not expose a PID cheaply, so this
 * always reports `pid: null`. */
export async function probeWindowsCoordinator(taskName: string): Promise<{
  loaded: boolean;
  pid: number | null;
}> {
  const process = Bun.spawn(["schtasks.exe", "/Query", "/TN", taskName, "/FO", "LIST"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  return { loaded: code === 0, pid: null };
}
