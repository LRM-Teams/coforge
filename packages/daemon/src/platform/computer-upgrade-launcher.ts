const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function computerUpgradeCommand(
  platform: NodeJS.Platform,
  executablePath: string,
  requestId: string,
  expectedVersion: string,
): string[] {
  if (!REQUEST_ID.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  if (!expectedVersion) throw new Error("missing expected Computer release version");
  const action = [
    executablePath,
    "__remote-upgrade",
    "--request-id",
    requestId,
    "--version",
    expectedVersion,
  ];
  if (platform === "linux")
    return [
      "systemd-run",
      "--user",
      "--collect",
      `--unit=coforge-upgrade-${requestId}.service`,
      "--property=Type=exec",
      ...action,
    ];
  if (platform === "darwin")
    return ["launchctl", "submit", "-l", `cn.coforge.upgrade.${requestId}`, "--", ...action];
  throw new Error("remote Computer upgrade has no safe external coordinator on this platform");
}

export async function launchComputerUpgrade(
  requestId: string,
  expectedVersion: string,
): Promise<void> {
  const command = computerUpgradeCommand(
    process.platform,
    process.execPath,
    requestId,
    expectedVersion,
  );
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0)
    throw new Error("external Computer upgrade coordinator was rejected");
}
