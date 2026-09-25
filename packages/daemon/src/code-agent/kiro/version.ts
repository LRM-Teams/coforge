import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/code-agent/version-gate";
import { KIRO_MIN_CLI_VERSION } from "./connection";

/** Kiro's ACP launch (`KIRO_ACP_ARGS`) requires the compatibility baseline. */
const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.KIRO,
  label: "Kiro CLI",
  executable: "kiro-cli",
  minimum: KIRO_MIN_CLI_VERSION,
});

export const isKiroVersionUnsupported = gate.isUnsupported;
export const logKiroVersionUnsupported = gate.logUnsupported;
export const assertKiroVersionSupported = gate.assertSupported;
