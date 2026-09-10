const STORAGE_KEY = "coforge-rail-labels";
const HIDDEN_CLASS = "rail-labels-hidden";

/** Per-device preference: captions under the rail icons. Applied as a class on <html>
 *  (also by the boot script in __root.tsx) so SSR markup never depends on it. */
export function readRailLabels(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "hide";
  } catch {
    return true;
  }
}

export function writeRailLabels(show: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, show ? "show" : "hide");
  } catch {
    // Private mode or blocked storage: the class still applies for this page.
  }
  document.documentElement.classList.toggle(HIDDEN_CLASS, !show);
}
