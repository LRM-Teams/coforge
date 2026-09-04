import { RUNTIME_PROVIDER, type RuntimeMetadata } from "@coforge/protocol";

/** Release-provided CoForge Agent identity; Computer registration currently has no daemon metadata merge seam. */
export const COFORGE_AGENT_RUNTIME_METADATA: RuntimeMetadata = {
  provider: RUNTIME_PROVIDER.COFORGE,
  version: "builtin",
  displayName: "CoForge",
  kind: "builtin",
};
