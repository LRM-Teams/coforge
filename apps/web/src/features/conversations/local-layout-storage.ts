import type { LayoutStorage } from "react-resizable-panels";

/**
 * `useDefaultLayout` defaults `storage` to `localStorage`, which throws during SSR. Pass this
 * instead for a panel group that mounts its panels only in the browser (the conversation's, the
 * Members page and the project tree), so its layout stays browser-persisted without crashing
 * Nitro's `renderToReadableStream`.
 */
export const localLayoutStorage: LayoutStorage = {
  getItem(key) {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  },
  setItem(key, value) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  },
};
