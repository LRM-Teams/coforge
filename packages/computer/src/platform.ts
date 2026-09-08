import { hostname } from "node:os";

export type SupportedPlatform = "darwin" | "linux" | "win32";
export type SupportedArchitecture = "x64" | "arm64";

export type ComputerPlatform = {
  os: SupportedPlatform;
  architecture: SupportedArchitecture;
  releaseTarget: string;
};

export function currentComputerPlatform(
  input: {
    platform?: string;
    architecture?: string;
  } = {},
): ComputerPlatform {
  const os = input.platform ?? process.platform;
  if (os !== "darwin" && os !== "linux" && os !== "win32") {
    throw new Error(`unsupported platform: ${os}`);
  }
  const architecture = input.architecture ?? process.arch;
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`unsupported architecture: ${architecture}`);
  }
  return {
    os,
    architecture,
    releaseTarget: `${os === "win32" ? "windows" : os}-${architecture}`,
  };
}

export function currentComputerNames(options: {
  platform: SupportedPlatform;
  hostname?: () => string;
  environment?: Readonly<Record<string, string | undefined>>;
  run?: (command: string[]) => string;
}): { name: string; displayName: string } {
  const name = (options.hostname ?? hostname)().trim() || "computer";
  const environment = options.environment ?? Bun.env;
  if (options.platform === "win32") {
    return { name, displayName: environment.COMPUTERNAME?.trim() || name };
  }

  try {
    const command =
      options.platform === "darwin"
        ? ["scutil", "--get", "ComputerName"]
        : ["hostnamectl", "--pretty"];
    const displayName = (options.run ?? run)(command).trim();
    return { name, displayName: displayName || name };
  } catch {
    return { name, displayName: name };
  }
}

function run(command: string[]): string {
  const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) throw new Error("computer name command failed");
  return result.stdout.toString();
}
