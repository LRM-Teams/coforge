import { createDevicePreference } from "./device-preference";
import { DEVICE_FLAG_HIDDEN } from "./device-flag";

/** Per-device preference: each Agent's model beside its name in chat. On unless this device
 * stored "hide". Nothing is drawn before the models load, so no boot class is needed. */
const preference = createDevicePreference<boolean>({
  key: "coforge-agent-model-name",
  parse: (stored) => stored !== DEVICE_FLAG_HIDDEN,
  serialize: (show) => (show ? "show" : DEVICE_FLAG_HIDDEN),
  fallback: true,
});

export const useAgentModelName = preference.useValue;
