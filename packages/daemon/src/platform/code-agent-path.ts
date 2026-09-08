import { posix, win32 } from "node:path";

export function codeAgentExecutableSearchPath(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  const homeDirectory = environment.HOME ?? environment.USERPROFILE;
  const userDirectories = homeDirectory
    ? [
        paths.join(homeDirectory, ".local", "bin"),
        paths.join(homeDirectory, ".pi", "agent", "bin"),
        paths.join(homeDirectory, ".bun", "bin"),
        paths.join(homeDirectory, ".volta", "bin"),
        paths.join(homeDirectory, ".local", "share", "mise", "shims"),
        paths.join(homeDirectory, ".asdf", "shims"),
      ]
    : [];
  const platformDirectories =
    platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin"]
      : platform === "win32" && environment.APPDATA
        ? [paths.join(environment.APPDATA, "npm")]
        : ["/usr/local/bin"];
  return [environment.PATH, ...userDirectories, ...platformDirectories]
    .filter((value): value is string => Boolean(value))
    .join(executablePathDelimiter(platform));
}

export function executablePathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ";" : ":";
}
