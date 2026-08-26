import { posix, win32 } from "node:path";

export type PathEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveComputerConfigDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  if (input.platform === "win32") {
    const localAppData = input.environment.LOCALAPPDATA;
    if (!localAppData || !win32.isAbsolute(localAppData)) {
      throw new Error("LOCALAPPDATA must be an absolute path");
    }
    return win32.join(localAppData, "Coforge");
  }

  if (input.platform === "darwin") {
    return posix.join(input.homeDirectory, "Library", "Application Support", "Coforge");
  }

  if (input.platform === "linux") {
    const configured = input.environment.XDG_CONFIG_HOME;
    const configHome =
      configured && posix.isAbsolute(configured)
        ? configured
        : posix.join(input.homeDirectory, ".config");
    return posix.join(configHome, "coforge");
  }

  throw new Error(`unsupported platform: ${input.platform}`);
}

export function resolveComputerStateDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  if (input.platform === "win32") {
    const localAppData = input.environment.LOCALAPPDATA;
    if (!localAppData || !win32.isAbsolute(localAppData)) {
      throw new Error("LOCALAPPDATA must be an absolute path");
    }
    return win32.join(localAppData, "Coforge");
  }

  if (input.platform === "darwin") {
    return posix.join(input.homeDirectory, "Library", "Application Support", "Coforge");
  }

  if (input.platform === "linux") {
    const configured = input.environment.XDG_STATE_HOME;
    const stateHome =
      configured && posix.isAbsolute(configured)
        ? configured
        : posix.join(input.homeDirectory, ".local", "state");
    return posix.join(stateHome, "coforge");
  }

  throw new Error(`unsupported platform: ${input.platform}`);
}
