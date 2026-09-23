import { getLogger } from "@logtape/logtape";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

/**
 * The Grok Build CLI baseline this runtime launches against.
 *
 * Grok 1.0 is the supported contract: the headless one-shot surface this adapter consumes
 * (`-p/--single` with `--output-format streaming-json`, `--always-approve`, `--no-memory`,
 * `--session-id`/`--resume`, `--model`, `--reasoning-effort`) is documented and observed from the
 * 1.0 series (1.0.40 verified 2026-09-22, 1.0.41 verified 2026-09-23 on `s144`). The streaming
 * format is ACP session updates, the agent's native wire format, one NDJSON line per update.
 */
export const GROK_MIN_CLI_VERSION = "1.0.0";

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

export function isGrokVersionUnsupported(version: string): boolean {
  return isVersionBelow(version, GROK_MIN_CLI_VERSION);
}

export function logGrokVersionUnsupported(name: string, version: string): void {
  logger.warning("Code Agent runtime version is below the supported minimum", {
    event: "code_agent_runtime:version_unsupported",
    provider: RUNTIME_PROVIDER.GROK,
    executable_name: name,
    version,
    minimum_version: GROK_MIN_CLI_VERSION,
    outcome: "unavailable",
  });
}

/**
 * Reads `[...command, "--version"]`, killing the child if it outlives the 5 s probe budget. Grok
 * prints `grok 1.0.41 (4220f3b224a6)` — the version is the token that parses as dotted numbers,
 * not the last word (the build hash is not a version).
 */
export async function readGrokVersion(command: readonly string[]): Promise<string | undefined> {
  const child = Bun.spawn({ cmd: [...command, "--version"], stdout: "pipe", stderr: "ignore" });
  try {
    const [output, exitCode] = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]),
      Bun.sleep(5_000).then(() => {
        throw new Error("runtime version probe timed out");
      }),
    ]);
    if (exitCode !== 0) return undefined;
    return output
      .trim()
      .split(/\s+/)
      .find((token) => /^\d+(\.\d+)*$/.test(token));
  } finally {
    child.kill();
  }
}

/**
 * Re-checks a Grok Agent launch's base command against the baseline immediately before spawn.
 * Runtime discovery already gates the reported inventory; this covers an existing Agent on a
 * Computer whose CLI is too old. A probe that fails, times out, or returns an unparseable version
 * never gates; only a confidently-parsed lower version blocks the launch.
 */
export async function assertGrokVersionSupported(command: readonly string[]): Promise<void> {
  let version: string | undefined;
  try {
    version = await readGrokVersion(command);
  } catch {
    return;
  }
  if (!version || !isGrokVersionUnsupported(version)) return;
  logGrokVersionUnsupported("grok", version);
  throw new Error(
    `Grok Build ${version} is unsupported; requires Grok Build >= ${GROK_MIN_CLI_VERSION}. ` +
      "Upgrade grok before starting this runtime.",
  );
}
