import { bootFragment } from "./boot-fragment";
import { DEVICE_FLAG_HIDDEN, readDeviceFlag, writeDeviceFlag } from "./device-flag";

const STORAGE_KEY = "coforge-hide-empty-sidebar-sections";
const HIDE_CLASS = "sidebar-hide-empty";

/** The boot half of the same rule: `__root.tsx` runs this before paint so SSR markup never depends
 * on the class. Built by `bootFragment` from the key, the hidden value and the class above, so the
 * script and `readHideEmptySidebarSections` cannot disagree about what "hidden" is stored as. */
export const HIDE_EMPTY_SIDEBAR_SECTIONS_BOOT = bootFragment({
  key: STORAGE_KEY,
  token: DEVICE_FLAG_HIDDEN,
  className: HIDE_CLASS,
});

/** The class an empty Chat sidebar section carries: hidden while the setting is on. Spelled out
 * in full so Tailwind finds it; the class it names is `HIDE_CLASS`. */
export const EMPTY_SECTION_HIDDEN_CLASS = "[.sidebar-hide-empty_&]:hidden";

/** Per-device preference: hide Pinned and Direct messages while they have nothing in them. Off
 *  unless this device stored the hidden value; applied as a class on <html> (also by the boot
 *  script). The setting is named after hiding, while the shared flag stores "shown" as its absence
 *  of a hidden value, so the two invert here rather than in storage: a device that stored either
 *  value, or nothing at all, reads the same as it did when this read `=== "hide"` itself. */
export function readHideEmptySidebarSections(): boolean {
  return !readDeviceFlag(STORAGE_KEY);
}

export function writeHideEmptySidebarSections(hide: boolean) {
  writeDeviceFlag(STORAGE_KEY, !hide);
  document.documentElement.classList.toggle(HIDE_CLASS, hide);
}
