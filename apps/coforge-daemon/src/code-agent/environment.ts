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
  // The daemon distribution places the sibling `coforge` executable next to
  // the compiled daemon.  Resolving from the executable, rather than cwd or
  // workspace node_modules, also works when Computer launches an installed
  // release from another directory.
  dirname(process.execPath),
  new URL("../../../dist/", import.meta.url).pathname,
  new URL("../../../../node_modules/.bin/", import.meta.url).pathname,
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
  const path = [declaredPath ?? environment.PATH, ...CLI_BIN_DIRECTORIES].filter(
    (value): value is string => Boolean(value),
  );
  return { ...environment, ...declared, PATH: path.join(":") };
}
