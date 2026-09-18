/**
 * Per-device collapse state for the Chat sidebar's CHANNELS / DIRECT MESSAGES groups.
 * Read only after mount (see `conversation-directory.tsx`) so SSR markup never depends on it —
 * same reasoning as `layout-storage.ts`, where touching `localStorage` during Nitro's
 * `renderToReadableStream` throws.
 */
export type DirectorySectionId = "channels" | "agents";

const STORAGE_KEY = "coforge-chat-sections-collapsed";

/** Collapsed sections, as a set of ids. An unreadable or malformed value means "all expanded". */
export function readCollapsedSections(): DirectorySectionId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is DirectorySectionId => id === "channels" || id === "agents");
  } catch {
    return [];
  }
}

export function writeCollapsedSections(ids: DirectorySectionId[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or blocked storage: the toggle still works for this page.
  }
}
