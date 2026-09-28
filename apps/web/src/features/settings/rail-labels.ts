import { bootFragment } from "./boot-fragment";
import { DEVICE_FLAG_HIDDEN, readDeviceFlag, writeDeviceFlag } from "./device-flag";

const STORAGE_KEY = "coforge-rail-labels";
const HIDDEN_CLASS = "rail-labels-hidden";

/** The boot half of the same rule: `__root.tsx` runs this before paint so SSR markup never depends
 * on the class. Built by `bootFragment` from the key, the hidden value and the class above, so the
 * script and `readRailLabels` cannot disagree about what "hidden" is stored as. */
export const RAIL_LABELS_BOOT = bootFragment({
  key: STORAGE_KEY,
  token: DEVICE_FLAG_HIDDEN,
  className: HIDDEN_CLASS,
});

/** Per-device preference: captions under the rail icons. Applied as a class on <html>
 *  (also by the boot script in __root.tsx) so SSR markup never depends on it. */
export function readRailLabels(): boolean {
  return readDeviceFlag(STORAGE_KEY);
}

export function writeRailLabels(show: boolean) {
  writeDeviceFlag(STORAGE_KEY, show);
  document.documentElement.classList.toggle(HIDDEN_CLASS, !show);
}
