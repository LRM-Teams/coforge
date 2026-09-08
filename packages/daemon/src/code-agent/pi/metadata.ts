import { RUNTIME_PROVIDER, type RuntimeMetadata } from "@coforge/protocol";
import { COFORGE_DAEMON_VERSION } from "../../version";

/** Release-provided CoForge Agent identity. */
export const COFORGE_AGENT_RUNTIME_METADATA: RuntimeMetadata = {
  provider: RUNTIME_PROVIDER.COFORGE,
  version: COFORGE_DAEMON_VERSION,
  displayName: "CoForge",
};
