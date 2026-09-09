import { release } from "node:os";

/** OS APIs have no Bun-native equivalent. Empty version means detection failed. */
export function readOperatingSystem(
  options: {
    platform?: string;
    release?: () => string;
    run?: (command: string[]) => string;
  } = {},
): { platform: string; osVersion: string } {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    return { platform: "", osVersion: "" };
  try {
    const osVersion =
      platform === "darwin"
        ? (options.run ?? run)(["/usr/bin/sw_vers", "-productVersion"])
        : (options.release ?? release)();
    return { platform, osVersion: osVersion.trim() };
  } catch {
    return { platform, osVersion: "" };
  }
}

function run(command: string[]): string {
  const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "ignore", timeout: 2_000 });
  if (result.exitCode !== 0) throw new Error("OS version unavailable");
  return result.stdout.toString();
}
