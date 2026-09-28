const STORAGE_KEY = "coforge-hide-empty-sidebar-sections";
const HIDE_CLASS = "sidebar-hide-empty";

/** The boot half of the same rule: `__root.tsx` runs this before paint so SSR markup never depends
 * on the class. Built from the key and class above, like `RAIL_LABELS_BOOT`. */
export const HIDE_EMPTY_SIDEBAR_SECTIONS_BOOT = `if(localStorage.getItem("${STORAGE_KEY}")==="hide"){document.documentElement.classList.add("${HIDE_CLASS}")}`;

/** The class an empty Chat sidebar section carries: hidden while the setting is on. Spelled out
 * in full so Tailwind finds it; the class it names is `HIDE_CLASS`. */
export const EMPTY_SECTION_HIDDEN_CLASS = "[.sidebar-hide-empty_&]:hidden";

/** Per-device preference: hide Pinned and Direct messages while they have nothing in them. Off
 *  unless this device stored "hide"; applied as a class on <html> (also by the boot script). */
export function readHideEmptySidebarSections(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "hide";
  } catch {
    return false;
  }
}

export function writeHideEmptySidebarSections(hide: boolean) {
  try {
    if (hide) localStorage.setItem(STORAGE_KEY, "hide");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the class still applies for this page.
  }
  document.documentElement.classList.toggle(HIDE_CLASS, hide);
}
