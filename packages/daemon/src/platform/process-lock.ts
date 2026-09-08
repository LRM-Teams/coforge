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
