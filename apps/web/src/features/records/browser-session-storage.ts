/**
 * The one browser-session-storage accessor for the Records feature: the Storage object, or
 * `undefined` when there is none to use.
 *
 * Both Records session recalls — the last visited path and the sidebar's expand state — carried this
 * identical guard. `sessionStorage` is absent during SSR, and even reaching for it can throw outright
 * when storage is blocked (private mode, partitioned contexts), so absence is a normal answer here
 * rather than an error: the callers simply fall back to their defaults.
 *
 * `Pick<Storage, "getItem" | "setItem">` is the shape both callers need; they each used to name it
 * privately (`PathStorage` / `ExpandStorage`).
 */
export type BrowserSessionStorage = Pick<Storage, "getItem" | "setItem">;

export function browserSessionStorage(): BrowserSessionStorage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}
