const STORAGE_KEY = "coforge-message-width";
const FULL_WIDTH_CLASS = "message-full-width";

/** The main message stream's side room: at most 6.5rem on each side, which with the
 *  rows' own gutter puts the avatars where the design mockup has them, and 10% of the pane when
 *  the pane is narrower than the mockup, so the room never grows with a wide
 *  screen. The history and the composer below it share this one class list so they always line
 *  up; full-width messages drop the room. Below `md` the rows' own gutter is enough. */
export const MESSAGE_COLUMN_CLASS = "md:px-[min(6.5rem,10%)] [.message-full-width_&]:px-0";

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
