const STORAGE_KEY = "coforge-live-agent-activity";
const CHANGE_EVENT = "coforge-live-agent-activity-change";

/** Per-device preference: the chat-list activity strip. On unless this device stored "hide". */
export function readLiveAgentActivity(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "hide";
  } catch {
    return true;
  }
}

export function writeLiveAgentActivity(show: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, show ? "show" : "hide");
  } catch {
    // Private mode or blocked storage: the current page still follows `show`.
  }
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
