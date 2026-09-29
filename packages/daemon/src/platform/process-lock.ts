import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type ProcessLock = {
  release(): void;
};

/** What a holder runs, in order, on its own connection to the lock database. Any process that
 * must exclude this one (the installer, too) runs the same statements on the same file; see
 * installer/contract/lock.json. */
export const PROCESS_LOCK_STATEMENTS = ["PRAGMA busy_timeout = 0", "BEGIN IMMEDIATE"] as const;

/** The SQLite result codes that mean another process holds the lock. */
export const PROCESS_LOCK_CONTENTION_CODES = ["SQLITE_BUSY", "SQLITE_LOCKED"] as const;

/**
 * Holds SQLite's native RESERVED lock for the lifetime of the returned handle.
 * The database is a permanent lock object: callers must never replace or remove it.
 */
export function acquireProcessLock(path: string): ProcessLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    for (const statement of PROCESS_LOCK_STATEMENTS) database.exec(statement);
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
    (PROCESS_LOCK_CONTENTION_CODES as readonly unknown[]).includes(error.code)
  );
}
