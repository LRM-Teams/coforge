import { dirname } from "node:path";
import {
  codeAgentExecutableSearchPath,
  executablePathDelimiter,
} from "../platform/code-agent-path";
import type { CoforgeAgentPromptContext } from "./agent-instructions";
import { resolveGitHookInjectionForLaunch, type GitHookInjectionPlan } from "./git-hooks";

const CLI_BIN_DIRECTORIES = [
  // Computer installs a version-local `coforge` launcher next to the daemon.
  // It invokes that version's Daemon binary, not a separately built CLI.
  dirname(process.execPath),
  new URL("../../node_modules/.bin/", import.meta.url).pathname,
] as const;

/** Env var names the Daemon authors itself: the Agent process capability sockets the launch site
 * (`runtime.ts`) sets directly, and the runtime-context variables `agentRuntimeContextEnvironment`
 * below maps from the same server-authored identity the standing prompt's "Current Runtime
 * Context" section renders. A same-named value from the host environment or an Agent's
 * user-configured `envVars`/adapter `extraEnv` must never reach the Agent process: an Agent's own
 * tools must not be able to spoof the Agent's identity to itself. Cleared here unconditionally, so
 * a call site that omits one of these keys from `declared` (because the value is unknown) still
 * cannot let a same-named inherited or user-supplied value through. */
const PROTECTED_COFORGE_ENV_KEYS = [
  "COFORGE_AGENT_CONTEXT",
  "COFORGE_AGENT_PROXY_URL",
  "COFORGE_DAEMON_SOCKET",
  "COFORGE_SUPERVISOR_SOCKET",
  "COFORGE_CURRENT_AGENT_ID",
  "COFORGE_CURRENT_AGENT_NAME",
  "COFORGE_CURRENT_WORKSPACE_ID",
  "COFORGE_CURRENT_WORKSPACE_SLUG",
  "COFORGE_CURRENT_WORKSPACE_NAME",
  "COFORGE_CURRENT_COMPUTER_ID",
  "COFORGE_CURRENT_COMPUTER_NAME",
  "COFORGE_CURRENT_COMPUTER_HOSTNAME",
  "COFORGE_CURRENT_COMPUTER_OS",
  "COFORGE_CURRENT_COMPUTER_VERSION",
  "COFORGE_CURRENT_AGENT_WORKSPACE_PATH",
  "COFORGE_GIT_CONFIG_BASE_COUNT",
] as const;

/** Strips CR/LF/NUL so a value can never inject a second env line or terminate the assignment
 * early; returns undefined when nothing usable remains. */
function singleLineOrUndefined(value: string | undefined): string | undefined {
  const sanitized = value?.replace(/[\r\n\0]/g, "");
  return sanitized ? sanitized : undefined;
}

/**
 * Maps the same server-authored Agent identity the standing prompt's "Current Runtime Context"
 * section renders (`agent-instructions.ts#buildRuntimeContextSection`) to environment variables,
 * so the Agent's own process and every tool it spawns (scripts, the `coforge` CLI) can read these
 * facts directly instead of parsing them out of prose. Each variable is present only when its
 * source value is a known, non-empty string after newline/NUL stripping; `displayName` and
 * `description` are deliberately not exported here (free text written by users, not needed by
 * tools — see `agent-instructions.ts`). The caller merges the result into `agentEnvironment`'s
 * `declared` argument, which `PROTECTED_COFORGE_ENV_KEYS` above always favors over inherited host
 * variables and the Agent's user-configured `envVars`/adapter `extraEnv`.
 */
export function agentRuntimeContextEnvironment(
  context: CoforgeAgentPromptContext,
): Record<string, string> {
  const runtimeContext = context.identity?.runtimeContext;
  const candidates: Record<string, string | undefined> = {
    COFORGE_CURRENT_AGENT_ID: context.agentId,
    COFORGE_CURRENT_AGENT_NAME: context.identity?.name,
    COFORGE_CURRENT_WORKSPACE_ID: runtimeContext?.workspaceId,
    COFORGE_CURRENT_WORKSPACE_SLUG: runtimeContext?.workspaceSlug,
    COFORGE_CURRENT_WORKSPACE_NAME: runtimeContext?.workspaceName,
    COFORGE_CURRENT_COMPUTER_ID: runtimeContext?.computerId,
    COFORGE_CURRENT_COMPUTER_NAME: runtimeContext?.computerName,
    COFORGE_CURRENT_COMPUTER_HOSTNAME: runtimeContext?.computerHostname,
    COFORGE_CURRENT_COMPUTER_OS: runtimeContext?.computerOs,
    COFORGE_CURRENT_COMPUTER_VERSION: runtimeContext?.computerVersion,
    COFORGE_CURRENT_AGENT_WORKSPACE_PATH: context.agentWorkspaceDirectory,
  };
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidates)) {
    const sanitized = singleLineOrUndefined(value);
    if (sanitized) environment[name] = sanitized;
  }
  return environment;
}

export function agentEnvironment(
  declared: Readonly<Record<string, string>> | undefined,
  inherited: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
  options: {
    envVars?: Readonly<Record<string, string>>;
    extraEnv?: Readonly<Record<string, string | undefined>>;
    /** How to inject the commit co-author trailer hook (`launchAgentEnvironment` resolves this by
     * probing the Agent's own `git`); omitted injects nothing, so every existing caller that only
     * scans or reads usage (never launches an Agent process) is unaffected. */
    gitHooks?: GitHookInjectionPlan;
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
  // Never reuse another Agent's local capability, the supervisor control socket, or a spoofed
  // runtime-identity value. Ordinary host variables (including provider credentials and proxies)
  // remain inherited.
  for (const key of PROTECTED_COFORGE_ENV_KEYS) delete environment[key];
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
  const entries: (readonly [string, string])[] = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!coforge github credential"],
    ["credential.https://github.com.useHttpPath", "true"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  // The commit co-author trailer hook (ADR: commit co-author trailer). `config-hook` runs
  // alongside the repository's own hooks (git >= 2.54); `hooks-path` needs `COFORGE_GIT_CONFIG_
  // BASE_COUNT` so the Daemon's forwarding shim can recover the pre-injection hooks path (see
  // `git-hook-shims.ts`) - the value is `gitConfigCount` exactly as inherited, before any of this
  // function's own entries (the GitHub credential helper included).
  if (options.gitHooks?.kind === "config-hook") {
    entries.push(
      ["hook.coforge-commit-trailers.event", "prepare-commit-msg"],
      // Git appends the hook arguments after `$0`; `|| true` keeps a missing or removed
      // `coforge` launcher from aborting the Agent's commit.
      [
        "hook.coforge-commit-trailers.command",
        `sh -c 'coforge git prepare-commit-msg "$@" || true' coforge-commit-trailers`,
      ],
    );
  } else if (options.gitHooks?.kind === "hooks-path") {
    entries.push(["core.hooksPath", options.gitHooks.hooksDir]);
  }
  for (const [offset, [key, value]] of entries.entries()) {
    result[`GIT_CONFIG_KEY_${gitConfigCount + offset}`] = key;
    result[`GIT_CONFIG_VALUE_${gitConfigCount + offset}`] = value;
  }
  result.GIT_CONFIG_COUNT = String(gitConfigCount + entries.length);
  if (options.gitHooks?.kind === "hooks-path")
    result.COFORGE_GIT_CONFIG_BASE_COUNT = String(gitConfigCount);
  return result;
}

/**
 * `agentEnvironment`, but also probes the Agent's own resolved `git` (with the exact `PATH` that
 * environment carries) and injects the commit co-author trailer hook the right way for that git's
 * version - see `git-hooks.ts`. Every Agent-process launch site should call this instead of
 * `agentEnvironment` directly; discovery/inventory/usage callers that never launch an Agent
 * process keep calling the plain, synchronous `agentEnvironment`.
 */
export async function launchAgentEnvironment(
  declared: Readonly<Record<string, string>> | undefined,
  inherited: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
  options: {
    envVars?: Readonly<Record<string, string>>;
    extraEnv?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<Record<string, string>> {
  const gitHooks = await resolveLaunchGitHooks(declared, inherited, platform, options);
  return agentEnvironment(declared, inherited, platform, { ...options, gitHooks });
}

/**
 * The git-hook-probing half of `launchAgentEnvironment`, split out for a provider whose session
 * spawns more than one process over its lifetime (Claude Code's fresh-session recreation, Cursor's
 * one-process-per-turn model): resolve this once per session and pass the same
 * `GitHookInjectionPlan` into each synchronous `agentEnvironment` call, rather than probing `git`
 * again for every process.
 */
export async function resolveLaunchGitHooks(
  declared: Readonly<Record<string, string>> | undefined,
  inherited: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
  options: {
    envVars?: Readonly<Record<string, string>>;
    extraEnv?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<GitHookInjectionPlan | undefined> {
  const base = agentEnvironment(declared, inherited, platform, options);
  return resolveGitHookInjectionForLaunch(base.PATH, platform);
}
