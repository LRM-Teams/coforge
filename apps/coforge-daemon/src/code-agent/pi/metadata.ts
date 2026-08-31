import { RUNTIME_PROVIDER, type RuntimeMetadata } from "@coforge/protocol";

/** Release-provided Pi identity; Computer registration currently has no daemon metadata merge seam. */
export const BUILTIN_PI_RUNTIME_METADATA: RuntimeMetadata = {
  provider: RUNTIME_PROVIDER.PI,
  version: "builtin",
  displayName: "Pi",
  kind: "builtin",
};
