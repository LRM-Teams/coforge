import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type ProcessLock = {
  release(): void;
};

/**
 * Holds SQLite's native RESERVED lock for the lifetime of the returned handle.
 * The database is a permanent lock object: callers must never replace or remove it.
 */
export function acquireProcessLock(path: string): ProcessLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    throw error;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      database.close();
    },
  };
}

/**
 * True when `error` is `acquireProcessLock` reporting that another process already holds the
 * RESERVED lock (bun:sqlite's `SQLITE_BUSY`/`SQLITE_LOCKED` under `busy_timeout = 0`), as opposed
 * to a broken or unreadable lock file. Callers use this to tell "someone else is using the lock"
 * apart from every other failure, which needs its own diagnosis instead of being folded into
 * "something else is running".
 */
export function isLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}
