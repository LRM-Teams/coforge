import { dirname } from "node:path";
import {
  codeAgentExecutableSearchPath,
  executablePathDelimiter,
} from "../platform/code-agent-path";

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
  options: {
    envVars?: Readonly<Record<string, string>>;
    extraEnv?: Readonly<Record<string, string | undefined>>;
  } = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...inherited,
    FORCE_COLOR: "0",
    ...options.envVars,
    ...options.extraEnv,
  })) {
    if (value !== undefined) environment[name] = value;
  }
  // Never reuse another Agent's local capability or the supervisor control socket.
  // Ordinary host variables (including provider credentials and proxies) remain inherited.
  for (const key of [
    "COFORGE_AGENT_CONTEXT",
    "COFORGE_AGENT_PROXY_URL",
    "COFORGE_DAEMON_SOCKET",
    "COFORGE_SUPERVISOR_SOCKET",
  ])
    delete environment[key];
  Object.assign(environment, declared);
  const seen = new Set<string>();
  const noProxy = [
    "127.0.0.1",
    "localhost",
    ...(environment.NO_PROXY ?? "").split(","),
    ...(environment.no_proxy ?? "").split(","),
  ]
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry || seen.has(entry.toLowerCase())) return false;
      seen.add(entry.toLowerCase());
      return true;
    })
    .join(",");
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;
  const declaredPath = declared?.PATH;
  const path = codeAgentExecutableSearchPath(
    {
      ...environment,
      PATH: declaredPath ?? environment.PATH,
    },
    platform,
  );
  const result: Record<string, string> = {
    ...environment,
    ...declared,
    PATH: [...CLI_BIN_DIRECTORIES, path].join(executablePathDelimiter(platform)),
  };
  const inheritedGitConfigCount = Number(result.GIT_CONFIG_COUNT ?? "0");
  const gitConfigCount =
    Number.isSafeInteger(inheritedGitConfigCount) && inheritedGitConfigCount >= 0
      ? inheritedGitConfigCount
      : 0;
  const entries = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!coforge github credential"],
    ["credential.https://github.com.useHttpPath", "true"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ] as const;
  for (const [offset, [key, value]] of entries.entries()) {
    result[`GIT_CONFIG_KEY_${gitConfigCount + offset}`] = key;
    result[`GIT_CONFIG_VALUE_${gitConfigCount + offset}`] = value;
  }
  result.GIT_CONFIG_COUNT = String(gitConfigCount + entries.length);
  return result;
}
