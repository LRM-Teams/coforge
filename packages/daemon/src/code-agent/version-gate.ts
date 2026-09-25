import { getLogger } from "@logtape/logtape";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

/**
 * The one CLI version gate every external code-agent runtime applies: read `--version` within a
 * 5-second budget, compare it as a confidently-parsed dotted number, warn, and refuse the launch.
 *
 * Grok, Kiro and OpenCode each carried a full copy of this — the same probe, the same comparison,
 * the same warning, and the same "unsupported; requires …; upgrade … before starting this runtime"
 * sentence with a different CLI name in it. What is genuinely per-provider stays a parameter: which
 * provider this is, the minimum version, how the CLI's `--version` output spells the version, and
 * the two names a person reads (the build's name in the error, the executable to upgrade).
 *
 * The rule that is easy to lose, and the reason one copy helps: a version that cannot be parsed as
 * dotted numbers is *never* gated. A missing, timed-out or unreadable `--version` must not refuse
 * a launch — only a confidently-parsed lower version does.
 */
export type CliVersionGate = {
  isUnsupported(version: string): boolean;
  logUnsupported(name: string, version: string): void;
  readVersion(command: readonly string[]): Promise<string | undefined>;
  assertSupported(command: readonly string[]): Promise<void>;
};

/** How long a `--version` probe may take before it is killed and its version treated as unread. */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

const dottedNumbers = (value: string) =>
  value.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));

function isVersionBelow(version: string, minimum: string): boolean {
  const actual = dottedNumbers(version);
  const min = dottedNumbers(minimum);
  if (actual.some(Number.isNaN) || min.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(actual.length, min.length); index++) {
    const a = actual[index] ?? 0;
    const m = min[index] ?? 0;
    if (a !== m) return a < m;
  }
  return false;
}

/** The CLI prints its version last (`kiro-cli 2.21.2`). */
const lastWhitespaceToken = (output: string) => output.trim().split(/\s+/).pop() || undefined;

/** Reads `[...command, "--version"]`, killing the child if it outlives the probe budget. */
async function readVersionOutput(
  command: readonly string[],
  versionFrom: (output: string) => string | undefined,
): Promise<string | undefined> {
  const child = Bun.spawn({ cmd: [...command, "--version"], stdout: "pipe", stderr: "ignore" });
  try {
    const [output, exitCode] = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]),
      Bun.sleep(VERSION_PROBE_TIMEOUT_MS).then(() => {
        throw new Error("runtime version probe timed out");
      }),
    ]);
    return exitCode === 0 ? versionFrom(output) : undefined;
  } finally {
    child.kill();
  }
}

export function cliVersionGate(options: {
  provider: RuntimeProvider;
  /** The build's name as the launch error says it: Grok Build, Kiro CLI, OpenCode. */
  label: string;
  /** The executable someone would upgrade: grok, kiro-cli, opencode. */
  executable: string;
  minimum: string;
  /** How this CLI's `--version` output spells the version; the last whitespace token by default. */
  versionFromOutput?: (output: string) => string | undefined;
}): CliVersionGate {
  const versionFrom = options.versionFromOutput ?? lastWhitespaceToken;
  const isUnsupported = (version: string) => isVersionBelow(version, options.minimum);
  const logUnsupported = (name: string, version: string): void => {
    logger.warning("Code Agent runtime version is below the supported minimum", {
      event: "code_agent_runtime:version_unsupported",
      provider: options.provider,
      executable_name: name,
      version,
      minimum_version: options.minimum,
      outcome: "unavailable",
    });
  };
  return {
    isUnsupported,
    logUnsupported,
    readVersion: (command) => readVersionOutput(command, versionFrom),
    /**
     * Re-checks a launch's base command against the minimum immediately before spawn. Discovery
     * already gates the reported inventory; this covers an existing Agent on a Computer whose CLI
     * is too old. A probe that fails, times out, or returns an unparseable version never gates.
     */
    async assertSupported(command: readonly string[]): Promise<void> {
      let version: string | undefined;
      try {
        version = await readVersionOutput(command, versionFrom);
      } catch {
        return;
      }
      if (!version || !isUnsupported(version)) return;
      logUnsupported(options.executable, version);
      throw new Error(
        `${options.label} ${version} is unsupported; requires ${options.label} >= ${options.minimum}. ` +
          `Upgrade ${options.executable} before starting this runtime.`,
      );
    },
  };
}
