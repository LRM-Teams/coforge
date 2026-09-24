const STORAGE_KEY = "coforge-message-width";
const FULL_WIDTH_CLASS = "message-full-width";

/** The main message stream's reading column: centered and capped at 52rem, which with the rows'
 *  own gutter leaves the 49rem of content the design mockup has; full-width messages lift the cap.
 *  The history and the composer below it share this one class list so they always line up. */
export const MESSAGE_COLUMN_CLASS =
  "mx-auto w-full max-w-[52rem] [.message-full-width_&]:max-w-none";

/** Per-device preference: full-width messages. Applied as a class on <html> (also by the boot
 *  script in __root.tsx) so SSR markup never depends on it. */
export function readMessageFullWidth(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "full";
  } catch {
    return false;
  }
}

export function writeMessageFullWidth(full: boolean) {
  try {
    if (full) localStorage.setItem(STORAGE_KEY, "full");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the class still applies for this page.
  }
  document.documentElement.classList.toggle(FULL_WIDTH_CLASS, full);
}
