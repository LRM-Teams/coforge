import { readDeviceFlag, writeDeviceFlag } from "./device-flag";

const STORAGE_KEY = "coforge-live-agent-activity";
const CHANGE_EVENT = "coforge-live-agent-activity-change";

/** Per-device preference: the chat-list activity strip. On unless this device stored "hide". */
export function readLiveAgentActivity(): boolean {
  return readDeviceFlag(STORAGE_KEY);
}

export function writeLiveAgentActivity(show: boolean) {
  writeDeviceFlag(STORAGE_KEY, show);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Same-tab updates. `storage` only fires in other tabs. */
export function subscribeLiveAgentActivity(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
