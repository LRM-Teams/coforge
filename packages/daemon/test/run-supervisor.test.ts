import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "#src/platform/process-lock";
import { acquireSupervisorLock } from "#src/supervisor/run-supervisor";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDirectory() {
  const root = await mkdtemp(join(tmpdir(), "coforge-run-supervisor-"));
  roots.push(root);
  return root;
}

/** `expect(...).rejects.toThrow(...)` only matches one fragment; this captures the real Error so
 * a test can assert on several parts of its message at once. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, got ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

test("another holder with a readable owner pid is named alongside both recovery commands", async () => {
  const directory = await stateDirectory();
  const lockPath = join(directory, "supervisor-lock.sqlite");
  const holder = acquireProcessLock(lockPath);
  await mkdir(join(directory, "supervisor.lock"), { recursive: true });
  await writeFile(join(directory, "supervisor.lock", "owner"), "4821");

  const error = await rejection(acquireSupervisorLock(directory));
  expect(error.message).toContain("Another CoForge Daemon is already running");
  expect(error.message).toContain("pid 4821");
  expect(error.message).toContain(lockPath);
  expect(error.message).toContain("coforge-computer status");
  expect(error.message).toContain("coforge-computer stop");

  holder.release();
});

test("a missing owner file still names the lock and the commands, without inventing a pid", async () => {
  const directory = await stateDirectory();
  const lockPath = join(directory, "supervisor-lock.sqlite");
  const holder = acquireProcessLock(lockPath);
  // No `supervisor.lock/owner` file exists yet - the real owner writes it only after taking the
  // lock, so a crash or a very early race can leave the lock held with no pid recorded.

  const error = await rejection(acquireSupervisorLock(directory));
  expect(error.message).toContain("Another CoForge Daemon is already running");
  expect(error.message).not.toMatch(/pid \d/);
  expect(error.message).toContain(lockPath);
  expect(error.message).toContain("coforge-computer status");
  expect(error.message).toContain("coforge-computer stop");

  holder.release();
});

test("a non-contention failure is not reported as another Daemon running", async () => {
  const directory = await stateDirectory();
  // A directory in place of the lock file cannot be opened as a SQLite database at all
  // (SQLITE_CANTOPEN), which is a broken/unreadable lock file, not lock contention.
  await mkdir(join(directory, "supervisor-lock.sqlite"), { recursive: true });

  const error = await rejection(acquireSupervisorLock(directory));
  expect(error.message).not.toContain("Another CoForge Daemon is already running");
  expect((error as NodeJS.ErrnoException).code).toBe("SQLITE_CANTOPEN");
});
