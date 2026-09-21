import { getLogger } from "@logtape/logtape";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

/**
 * The OpenCode CLI baseline this runtime launches against.
 *
 * 1.15 is where OpenCode's own model catalog and non-interactive surface match what the daemon
 * uses (`opencode run --format json`, `--variant`, `--dangerously-skip-permissions`; Raft's
 * adapter records the same baseline: "Newer opencode (1.15+) syncs its hosted free-model catalog
 * over the network on `opencode models`"). An older build silently prints its usage and exits 0
 * when handed a flag it does not know, so gating on the version is what keeps a stale install
 * from looking like a healthy runtime that never runs anything.
 */
export const OPENCODE_MIN_CLI_VERSION = "1.15.0";

/**
 * A confidently-parsed dotted numeric version below `minimum` is rejected; a version that cannot
 * be parsed this way (missing, non-numeric segments) is never gated.
 */
function isVersionBelow(version: string, minimum: string): boolean {
  const parse = (value: string) =>
    value.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  const actual = parse(version);
  const min = parse(minimum);
  if (actual.some(Number.isNaN) || min.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(actual.length, min.length); index++) {
    const a = actual[index] ?? 0;
    const m = min[index] ?? 0;
    if (a !== m) return a < m;
  }
  return false;
}

export function isOpenCodeVersionUnsupported(version: string): boolean {
  return isVersionBelow(version, OPENCODE_MIN_CLI_VERSION);
}

export function logOpenCodeVersionUnsupported(name: string, version: string): void {
  logger.warning("Code Agent runtime version is below the supported minimum", {
    event: "code_agent_runtime:version_unsupported",
    provider: RUNTIME_PROVIDER.OPENCODE,
    executable_name: name,
    version,
    minimum_version: OPENCODE_MIN_CLI_VERSION,
    outcome: "unavailable",
  });
}

/** Reads `[...command, "--version"]`, killing the child if it outlives the 5 s probe budget. */
async function readOpenCodeVersion(command: readonly string[]): Promise<string | undefined> {
  const child = Bun.spawn({ cmd: [...command, "--version"], stdout: "pipe", stderr: "ignore" });
  try {
    const [output, exitCode] = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]),
      Bun.sleep(5_000).then(() => {
        throw new Error("runtime version probe timed out");
      }),
    ]);
    return exitCode === 0 ? output.trim().split(/\s+/).pop() || undefined : undefined;
  } finally {
    child.kill();
  }
}

/**
 * Re-checks an OpenCode Agent launch's base command against the baseline immediately before spawn.
 * Runtime discovery already gates the reported inventory; this covers an existing Agent on a
 * Computer whose CLI is too old. A probe that fails, times out, or returns an unparseable version
 * never gates; only a confidently-parsed lower version blocks the launch.
 */
export async function assertOpenCodeVersionSupported(command: readonly string[]): Promise<void> {
  let version: string | undefined;
  try {
    version = await readOpenCodeVersion(command);
  } catch {
    return;
  }
  if (!version || !isOpenCodeVersionUnsupported(version)) return;
  logOpenCodeVersionUnsupported("opencode", version);
  throw new Error(
    `OpenCode ${version} is unsupported; requires OpenCode >= ${OPENCODE_MIN_CLI_VERSION}. ` +
      "Upgrade opencode before starting this runtime.",
  );
}
