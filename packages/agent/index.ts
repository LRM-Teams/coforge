import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

export const provider = RUNTIME_PROVIDER.COFORGE;
export { RUNTIME_PROVIDER };
export { API_KEY_ENV_BY_PROVIDER } from "./src/runtime-provider";
export {
  createSession,
  discoverModels,
  discoverPiModels,
  findSessionFile,
  resolveAgentSessionFile,
} from "./src/runner";
export { classifyPiLaunchFailure, PiLaunchError, piLaunchTrace } from "./src/launch-error";
export type { PiLaunchCategory, PiLaunchTrace } from "./src/launch-error";
export { getAgentDir, VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
export { COFORGE_PROVIDER_MODELS_GENERATED } from "./src/coforge-provider-models.generated";
export {
  getCoforgeAgentDir,
  getCoforgeSessionDir,
  prepareAgentSessionDirectory,
} from "./src/paths";
export type {
  AgentActivity,
  AgentActivityLevel,
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentRuntimeProviderConfig,
  AgentSession,
  AgentSessionIdentity,
  AgentGitHookPlan,
  AgentSessionOptions,
  UsageSnapshot,
  UsageWindow,
} from "./src/contract";
