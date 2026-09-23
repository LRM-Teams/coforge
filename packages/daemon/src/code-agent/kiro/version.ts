import { getLogger } from "@logtape/logtape";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { KIRO_MIN_CLI_VERSION } from "./connection";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

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

/** Kiro's ACP launch (`KIRO_ACP_ARGS`) requires the compatibility baseline. */
export function isKiroVersionUnsupported(version: string): boolean {
  return isVersionBelow(version, KIRO_MIN_CLI_VERSION);
}

export function logKiroVersionUnsupported(name: string, version: string): void {
  logger.warning("Code Agent runtime version is below the supported minimum", {
    event: "code_agent_runtime:version_unsupported",
    provider: RUNTIME_PROVIDER.KIRO,
    executable_name: name,
    version,
    minimum_version: KIRO_MIN_CLI_VERSION,
    outcome: "unavailable",
  });
}

/** Reads `[...command, "--version"]`, killing the child if it outlives the 5 s probe budget. */
async function readKiroVersion(command: readonly string[]): Promise<string | undefined> {
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
 * Re-checks a Kiro Agent launch's base command against the compatibility minimum immediately before
 * spawn. Runtime discovery already gates the reported inventory; this covers an existing Agent on
 * a Computer whose CLI is too old. A probe that fails, times out, or returns an unparseable
 * version never gates; only a confidently-parsed lower version blocks the launch.
 */
export async function assertKiroVersionSupported(command: readonly string[]): Promise<void> {
  let version: string | undefined;
  try {
    version = await readKiroVersion(command);
  } catch {
    return;
  }
  if (!version || !isKiroVersionUnsupported(version)) return;
  logKiroVersionUnsupported("kiro-cli", version);
  throw new Error(
    `Kiro CLI ${version} is unsupported; requires Kiro CLI >= ${KIRO_MIN_CLI_VERSION}. ` +
      "Upgrade kiro-cli before starting this runtime.",
  );
}
