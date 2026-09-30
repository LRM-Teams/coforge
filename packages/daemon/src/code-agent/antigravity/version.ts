import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/code-agent/version-gate";

/**
 * The Antigravity CLI (`agy`) baseline this runtime launches against.
 *
 * A per-turn runtime treats the process exit as the turn's verdict. agy 1.2.6 made a headless run
 * that ends on a model or agent error exit with code 3 (and print `AGY_ERROR: {...}` on stderr);
 * 1.2.10 fixed the case that still exited 0 - a run that streamed part of a response before the
 * error (agy changelog). Below 1.2.10 such a failed turn would read as a clean one. The other
 * headless surface consumed here, `--input-format stream-json`, arrived in 1.1.15. Verified live
 * on 1.2.12 and 1.2.13.
 */
export const ANTIGRAVITY_MIN_CLI_VERSION = "1.2.10";

// `agy --version` prints just the version (`1.2.13`), possibly after a wrapper's own line, so the
// gate's default last-whitespace-token parse reads it.
const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.ANTIGRAVITY,
  label: "Antigravity CLI",
  executable: "agy",
  minimum: ANTIGRAVITY_MIN_CLI_VERSION,
});

export const isAntigravityVersionUnsupported = gate.isUnsupported;
export const logAntigravityVersionUnsupported = gate.logUnsupported;
export const assertAntigravityVersionSupported = gate.assertSupported;
