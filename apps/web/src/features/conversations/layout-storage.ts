import type { LayoutStorage } from "react-resizable-panels";

/**
 * `useDefaultLayout` defaults `storage` to `localStorage`, which throws during SSR.
 * Pass this instead so conversation panel layouts stay browser-persisted without
 * crashing Nitro's `renderToReadableStream`.
 */
export const conversationLayoutStorage: LayoutStorage = {
  getItem(key) {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  },
  setItem(key, value) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  },
};
