import { delimiter, dirname, join } from "node:path";

const SAFE_INHERITED_ENVIRONMENT = [
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
] as const;

const CLI_BIN_DIRECTORIES = [
  // Computer installs a version-local `coforge` launcher next to the daemon.
  // It invokes that version's Daemon binary, not a separately built CLI.
  dirname(process.execPath),
  new URL("../../node_modules/.bin/", import.meta.url).pathname,
] as const;

export function agentEnvironment(
  declared: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const declaredPath = declared?.PATH;
  const path = codeAgentExecutableSearchPath({
    ...environment,
    PATH: declaredPath ?? environment.PATH,
  });
  return { ...environment, ...declared, PATH: [...CLI_BIN_DIRECTORIES, path].join(delimiter) };
}

export function codeAgentExecutableSearchPath(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const homeDirectory = environment.HOME ?? environment.USERPROFILE;
  const userDirectories = homeDirectory
    ? [
        join(homeDirectory, ".local", "bin"),
        join(homeDirectory, ".pi", "agent", "bin"),
        join(homeDirectory, ".bun", "bin"),
        join(homeDirectory, ".volta", "bin"),
        join(homeDirectory, ".local", "share", "mise", "shims"),
        join(homeDirectory, ".asdf", "shims"),
      ]
    : [];
  const platformDirectories =
    platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin"]
      : platform === "win32" && environment.APPDATA
        ? [join(environment.APPDATA, "npm")]
        : ["/usr/local/bin"];
  return [environment.PATH, ...userDirectories, ...platformDirectories]
    .filter((value): value is string => Boolean(value))
    .join(delimiter);
}
