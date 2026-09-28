import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/code-agent/version-gate";

/**
 * The OpenCode CLI baseline this runtime launches against.
 *
 * OpenCode v2 is the supported CLI contract. Its `opencode run` command retains the machine
 * interface this adapter consumes (`--format json`, `--model`, `--variant`, `--session`, and
 * `--dir`), while v1 is no longer a supported runtime surface. An older build can silently print
 * its usage and exit 0 when handed a flag it does not know, so gating on the major version keeps a
 * stale v1 install from looking like a healthy runtime that never runs anything. The v2 command
 * and event shape are documented at https://opencode.ai/v2/docs/cli/commands/.
 */
export const OPENCODE_MIN_CLI_VERSION = "2.0.0";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.OPENCODE,
  label: "OpenCode",
  executable: "opencode",
  minimum: OPENCODE_MIN_CLI_VERSION,
});

export const isOpenCodeVersionUnsupported = gate.isUnsupported;
export const logOpenCodeVersionUnsupported = gate.logUnsupported;
export const assertOpenCodeVersionSupported = gate.assertSupported;
