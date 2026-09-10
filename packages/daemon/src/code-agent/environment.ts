import { dirname } from "node:path";
import {
  codeAgentExecutableSearchPath,
  executablePathDelimiter,
} from "../platform/code-agent-path";

const SAFE_INHERITED_ENVIRONMENT = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const CLI_BIN_DIRECTORIES = [
  // Computer installs a version-local `coforge` launcher next to the daemon.
  // It invokes that version's Daemon binary, not a separately built CLI.
  dirname(process.execPath),
  new URL("../../node_modules/.bin/", import.meta.url).pathname,
] as const;

export function agentEnvironment(
  declared: Readonly<Record<string, string>> | undefined,
  inherited: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT) {
    const value = inherited[name];
    if (value !== undefined) environment[name] = value;
  }
  const declaredPath = declared?.PATH;
  const path = codeAgentExecutableSearchPath(
    {
      ...environment,
      PATH: declaredPath ?? environment.PATH,
    },
    platform,
  );
  return {
    ...environment,
    ...declared,
    PATH: [...CLI_BIN_DIRECTORIES, path].join(executablePathDelimiter(platform)),
  };
}
