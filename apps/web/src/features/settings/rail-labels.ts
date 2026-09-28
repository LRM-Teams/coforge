import { DEVICE_FLAG_HIDDEN, readDeviceFlag, writeDeviceFlag } from "./device-flag";

const STORAGE_KEY = "coforge-rail-labels";
const HIDDEN_CLASS = "rail-labels-hidden";

/** The boot half of the same rule: `__root.tsx` runs this before paint so SSR markup never depends
 * on the class. Built from the key and class above, like `TASK_DISPLAY_FIELDS_BOOT`, so the script
 * and `readRailLabels` cannot disagree about what "hidden" is stored as. */
export const RAIL_LABELS_BOOT = `if(localStorage.getItem("${STORAGE_KEY}")==="${DEVICE_FLAG_HIDDEN}"){document.documentElement.classList.add("${HIDDEN_CLASS}")}`;

/** Per-device preference: captions under the rail icons. Applied as a class on <html>
 *  (also by the boot script in __root.tsx) so SSR markup never depends on it. */
export function readRailLabels(): boolean {
  return readDeviceFlag(STORAGE_KEY);
}

export function writeRailLabels(show: boolean) {
  writeDeviceFlag(STORAGE_KEY, show);
  document.documentElement.classList.toggle(HIDDEN_CLASS, !show);
}
