import { clear, createStore, del, entries, get, keys, set, type UseStore } from "idb-keyval";

import type { PersistedQueryStore } from "./query-cache-persistence";

const DATABASE = "coforge-query-cache";
const TABLE = "queries";

/**
 * The kept queries in IndexedDB (the store TanStack Query's own persistence guide uses:
 * `idb-keyval`), one database of one table. The database opens on first use, so a page that never
 * reads or writes it (or a browser without IndexedDB, where the first use fails) costs nothing.
 */
export function createIdbStore(): PersistedQueryStore {
  let opened: UseStore | undefined;
  const table = () => (opened ??= createStore(DATABASE, TABLE));
  return {
    get: (key) => get(key, table()),
    set: (key, value) => set(key, value, table()),
    delete: (key) => del(key, table()),
    keys: async () => (await keys(table())).filter((key) => typeof key === "string"),
    entries: async () =>
      (await entries(table())).filter((entry): entry is [string, unknown] => {
        return typeof entry[0] === "string";
      }),
    clear: () => clear(table()),
  };
}
