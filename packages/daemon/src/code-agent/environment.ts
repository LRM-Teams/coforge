import { dirname } from "node:path";

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
  const path = [...CLI_BIN_DIRECTORIES, declaredPath ?? environment.PATH].filter(
    (value): value is string => Boolean(value),
  );
  return { ...environment, ...declared, PATH: path.join(":") };
}
