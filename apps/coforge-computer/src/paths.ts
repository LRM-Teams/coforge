import { posix, win32 } from "node:path";

export type PathEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveComputerConfigDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  return joinUserDirectory(input, "computer");
}

export function resolveComputerStateDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  return joinUserDirectory(input, "daemon");
}

export function resolveComputerInstallDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  return joinUserDirectory(input, "computer", "install");
}

export function resolveComputerBinaryDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  return joinUserDirectory(input, "computer", "bin");
}

function joinUserDirectory(
  input: { platform: NodeJS.Platform; homeDirectory: string },
  ...parts: string[]
): string {
  if (input.platform === "win32") return win32.join(input.homeDirectory, ".coforge", ...parts);
  if (input.platform === "linux" || input.platform === "darwin") {
    return posix.join(input.homeDirectory, ".coforge", ...parts);
  }
  throw new Error(`unsupported platform: ${input.platform}`);
}

export function resolveDaemonSocketPath(input: {
  platform: NodeJS.Platform;
  stateDirectory: string;
}): string {
  if (input.platform === "win32") return "\\\\.\\pipe\\coforge-daemon";
  if (input.platform === "linux" || input.platform === "darwin") {
    return posix.join(input.stateDirectory, "daemon.sock");
  }
  throw new Error(`unsupported platform: ${input.platform}`);
}
