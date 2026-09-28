import { browserLocalStorage } from "#src/features/browser-local-storage";

/** How a hidden per-device flag is stored. Anything else reads as shown: these flags hide UI, so a
 * device that never expressed a preference keeps the default. */
export const DEVICE_FLAG_HIDDEN = "hide";
const DEVICE_FLAG_SHOWN = "show";

/** Reads a per-device boolean flag. Absent, unreadable or blocked storage reads as true. */
export function readDeviceFlag(key: string): boolean {
  try {
    return browserLocalStorage()?.getItem(key) !== DEVICE_FLAG_HIDDEN;
  } catch {
    return true;
  }
}

/** Writes one. A blocked storage is not an error: the current page still follows `show`. */
export function writeDeviceFlag(key: string, show: boolean): void {
  try {
    browserLocalStorage()?.setItem(key, show ? DEVICE_FLAG_SHOWN : DEVICE_FLAG_HIDDEN);
  } catch {
    // Private mode or blocked storage.
  }
}
