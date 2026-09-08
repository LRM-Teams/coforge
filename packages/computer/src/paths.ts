import { posix, win32 } from "node:path";

export type PathEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveComputerConfigDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  return joinUserDirectory(input, "computer");
}

/** Resolves the Computer credential root without introducing a profile concept. */
export function resolveComputerCredentialsDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  const credentialsDirectory = input.environment.COFORGE_COMPUTER_CREDENTIALS_DIR;
  if (credentialsDirectory) return credentialsDirectory;
  const computerHome = input.environment.COFORGE_COMPUTER_HOME;
  if (computerHome) return joinPlatformDirectory(input.platform, computerHome, "credentials");
  return joinUserDirectory(input, "computer", "credentials");
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

/**
 * Resolves the directory holding the `coforge-computer` shim - the single installed path that
 * must enter the user's PATH. Unlike every other Computer directory it deliberately does not sit
 * under `~/.coforge`: a private directory is on nobody's PATH, so it would force the installer to
 * edit shell configuration and leave the just-installed command unusable until the next shell.
 * Linux and macOS therefore use the XDG user binary directory, which is already on PATH for most
 * users, and the shim there is only a symlink into the versioned installation below `~/.coforge`.
 * Windows has no comparable per-user PATH convention and keeps the private directory.
 */
export function resolveComputerBinaryDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  if (input.platform === "linux" || input.platform === "darwin") {
    const configured = input.environment.XDG_BIN_HOME;
    return configured && posix.isAbsolute(configured)
      ? configured
      : posix.join(input.homeDirectory, ".local", "bin");
  }
  return joinUserDirectory(input, "computer", "bin");
}

function joinUserDirectory(
  input: { platform: NodeJS.Platform; homeDirectory: string },
  ...parts: string[]
): string {
  return joinPlatformDirectory(input.platform, input.homeDirectory, ".coforge", ...parts);
}

function joinPlatformDirectory(
  platform: NodeJS.Platform,
  base: string,
  ...parts: string[]
): string {
  if (platform === "win32") return win32.join(base, ...parts);
  if (platform === "linux" || platform === "darwin") {
    return posix.join(base, ...parts);
  }
  throw new Error(`unsupported platform: ${platform}`);
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
