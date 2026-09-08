export { LaunchdDaemonHost, launchdPlist } from "./launchd";
export { SystemdUserDaemonHost, systemdUserUnit } from "./systemd-user";
export { WindowsUserDaemonHost } from "./windows-task";
export { LocalDaemonLauncher, resolveDaemonExecutablePath } from "./launcher";

import { LaunchdDaemonHost } from "./launchd";
import { SystemdUserDaemonHost } from "./systemd-user";
import { WindowsUserDaemonHost } from "./windows-task";

export function createDaemonHost(input: {
  platform: NodeJS.Platform;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  serverUrl?: string;
  daemonConnectionEndpoint?: string;
  homeDirectory: string;
  uid: number;
  serviceName?: string;
  runtimeHomeDirectory?: string;
}) {
  if (input.platform === "darwin") {
    return new LaunchdDaemonHost({ ...input, label: "cn.coforge.computer.daemon" });
  }
  if (input.platform === "linux") return new SystemdUserDaemonHost(input);
  if (input.platform === "win32") return new WindowsUserDaemonHost(input);
  throw new Error(`unsupported platform: ${input.platform}`);
}
