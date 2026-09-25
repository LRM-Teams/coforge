import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/code-agent/version-gate";

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

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.GROK,
  label: "Grok Build",
  executable: "grok",
  minimum: GROK_MIN_CLI_VERSION,
  // Grok prints `grok 1.0.41 (4220f3b224a6)` — the version is the token that parses as dotted
  // numbers, not the last word (the build hash is not a version).
  versionFromOutput: (output) =>
    output
      .trim()
      .split(/\s+/)
      .find((token) => /^\d+(\.\d+)*$/.test(token)),
});

export const isGrokVersionUnsupported = gate.isUnsupported;
export const logGrokVersionUnsupported = gate.logUnsupported;
export const readGrokVersion = gate.readVersion;
export const assertGrokVersionSupported = gate.assertSupported;
