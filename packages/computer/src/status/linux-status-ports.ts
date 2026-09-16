/** Mirrors the `systemctl --user show` query in `SystemdWorkspaceInstance#show`
 * (packages/daemon/src/supervisor/systemd-workspace-instance.ts): read-only, one call, no
 * mutation. Unlike a Workspace unit the Coordinator's service name is fixed
 * (`SystemdUserDaemonHost`'s default in packages/daemon/src/daemon-host/systemd-user.ts). */
export async function probeLinuxCoordinator(serviceName: string): Promise<{
  loaded: boolean;
  pid: number | null;
}> {
  const process = Bun.spawn(
    [
      "systemctl",
      "--user",
      "show",
      serviceName,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=MainPID",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  if (code !== 0) return { loaded: false, pid: null };
  const properties = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (properties.get("LoadState") !== "loaded") return { loaded: false, pid: null };
  const pid = Number(properties.get("MainPID") ?? "0");
  return { loaded: true, pid: Number.isFinite(pid) && pid > 0 ? pid : null };
}
