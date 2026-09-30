import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/code-agent/version-gate";

/**
 * The Grok Build CLI baseline this runtime launches against.
 *
 * Grok 1.0 is the supported contract: the headless one-shot surface this adapter consumes
 * (`-p/--single` with `--output-format streaming-json`, `--session-id`/`--resume`, `--model`,
 * `--reasoning-effort`) is documented; `--always-approve` is in `grok --help` but not the guide,
 * and `--no-memory` and `--trust` are hidden flags. All of them are observed on 1.0.40 and 1.0.41
 * only. The streaming format is ACP session updates, one NDJSON line per update.
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
