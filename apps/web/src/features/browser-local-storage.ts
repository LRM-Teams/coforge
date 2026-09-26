/**
 * The browser's local storage, or `null` when there is none to use.
 *
 * `localStorage` is absent during SSR, and even reaching for it can throw outright when storage is
 * blocked (private mode, partitioned contexts). The composer drafts and the search-usage memory
 * carried this identical guard inline; callers treat `null` as "remember nothing this render".
 *
 * Deliberately not adopted everywhere: `conversations/layout-storage.ts` guards the same way but
 * without the throw guard, and `settings/device-preference.ts` reads storage through a
 * `useSyncExternalStore` cache whose failure semantics are its own. Making either use this would
 * change what happens when storage is blocked — a decision about failure modes, not a rename.
 */
export function browserLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
