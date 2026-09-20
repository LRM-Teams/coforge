import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How far back a crash still counts toward the degraded threshold. */
export const WORKSPACE_HEALTH_CRASH_WINDOW_MS = 60_000;
/** How many unexpected deaths inside the window latch the Workspace degraded. */
export const WORKSPACE_HEALTH_DEGRADED_THRESHOLD = 3;

const CRASH_LOOP_REASON = `this Workspace exited unexpectedly ${WORKSPACE_HEALTH_DEGRADED_THRESHOLD} times within ${
  WORKSPACE_HEALTH_CRASH_WINDOW_MS / 1000
}s`;

export type WorkspaceHealthState =
  | { status: "ok" }
  | { status: "degraded"; reason: string; crashCount: number; since: string };

type PersistedWorkspaceHealth = {
  schemaVersion: 1;
  /** True from `recordStart()` until the same run calls `recordGracefulStop()`. A later run that
   * finds this still true knows its predecessor never shut down cleanly. */
  live: boolean;
  /** Unexpected-death timestamps (ms epoch), pruned to the crash window on every `recordCrash`. */
  crashes: number[];
  /** Set once by `markTerminal`; a condition restarting cannot fix. Never cleared except by
   * `clear()`. */
  terminal?: { reason: string; at: number };
  /** Set once `crashes` reaches the threshold; frozen at that moment so the latch does not lift
   * on its own once the triggering crashes age out of the window. */
  degraded?: { crashCount: number; at: number };
};

const EMPTY_RECORD: PersistedWorkspaceHealth = { schemaVersion: 1, live: false, crashes: [] };

/** Where one Workspace's durable health record lives under its own state directory (the same
 * directory the Coordinator passes to `__workspace-daemon` as `--state-directory`). Both the
 * child that writes it and a read-only observer (e.g. Computer's `status` command, through the
 * Coordinator) must derive this path the same way, so it is exposed here rather than recomputed
 * at each call site. */
export function workspaceHealthJournalPath(workspaceStateDirectory: string): string {
  return join(workspaceStateDirectory, "health.json");
}

/**
 * Durable per-Workspace crash/latch state, next to the Workspace's own state directory. There is
 * no process supervising the Workspace child's exit - the OS restarts it directly - so the child
 * itself is the only place that can notice its predecessor did not shut down cleanly, and the
 * only place that can decide the restart loop has gone bad often enough to stop itself.
 *
 * A missing or corrupt file reads as a fresh, healthy journal: this is best-effort observability,
 * and losing one record must never itself force a Workspace degraded.
 */
export class WorkspaceHealthJournal {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Marks this run live. Call once a Workspace daemon has decided to actually start (i.e. after
   * `state()` was not degraded). */
  async recordStart(): Promise<void> {
    const record = await this.#read();
    await this.#write({ ...record, live: true });
  }

  /** Marks a clean shutdown (SIGTERM/SIGINT, or an explicit operator stop) so the next start does
   * not mistake it for an unexpected death. */
  async recordGracefulStop(): Promise<void> {
    const record = await this.#read();
    await this.#write({ ...record, live: false });
  }

  /** True when the previous run left the live marker set - i.e. it never reached
   * `recordGracefulStop()` - which is this journal's only way to observe that its predecessor
   * died unexpectedly. Reads only; does not mutate the marker itself. */
  async wasLeftRunning(): Promise<boolean> {
    return (await this.#read()).live === true;
  }

  /** Records one unexpected death, pruning crashes outside the window first. Latches degraded the
   * moment the pruned count reaches the threshold; a later call is a no-op once already latched
   * degraded or terminal, so the frozen crash count and reason are never overwritten. */
  async recordCrash(at: number = this.now()): Promise<void> {
    const record = await this.#read();
    if (record.terminal || record.degraded) return;
    const crashes = pruneWindow([...record.crashes, at], this.now());
    const degraded =
      crashes.length >= WORKSPACE_HEALTH_DEGRADED_THRESHOLD
        ? { crashCount: crashes.length, at }
        : undefined;
    await this.#write({ ...record, crashes, ...(degraded ? { degraded } : {}) });
  }

  /** Latches degraded immediately for a condition that restarting cannot fix, independent of any
   * crash count. */
  async markTerminal(reason: string): Promise<void> {
    const record = await this.#read();
    await this.#write({ ...record, terminal: { reason, at: this.now() } });
  }

  /** What an explicit operator start/restart calls: clears both the terminal and crash-loop
   * latches so the Workspace gets a fresh budget. Never touches the live marker - the next
   * `recordStart()` sets that independently. */
  async clear(): Promise<void> {
    const record = await this.#read();
    await this.#write({ ...record, crashes: [], terminal: undefined, degraded: undefined });
  }

  async state(): Promise<WorkspaceHealthState> {
    const record = await this.#read();
    if (record.terminal) {
      return {
        status: "degraded",
        reason: record.terminal.reason,
        crashCount: pruneWindow(record.crashes, this.now()).length,
        since: new Date(record.terminal.at).toISOString(),
      };
    }
    if (record.degraded) {
      return {
        status: "degraded",
        reason: CRASH_LOOP_REASON,
        crashCount: record.degraded.crashCount,
        since: new Date(record.degraded.at).toISOString(),
      };
    }
    return { status: "ok" };
  }

  async #read(): Promise<PersistedWorkspaceHealth> {
    try {
      const value: unknown = await Bun.file(this.path).json();
      return valid(value) ? value : EMPTY_RECORD;
    } catch {
      return EMPTY_RECORD;
    }
  }

  async #write(record: PersistedWorkspaceHealth): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record) + "\n", { mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function pruneWindow(crashes: number[], now: number): number[] {
  return crashes.filter((at) => now - at < WORKSPACE_HEALTH_CRASH_WINDOW_MS);
}

function valid(value: unknown): value is PersistedWorkspaceHealth {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.live !== "boolean") return false;
  if (!Array.isArray(record.crashes) || !record.crashes.every((at) => Number.isFinite(at)))
    return false;
  if (record.terminal !== undefined) {
    const terminal = record.terminal as Record<string, unknown>;
    if (typeof terminal !== "object" || terminal === null) return false;
    if (typeof terminal.reason !== "string" || !Number.isFinite(terminal.at)) return false;
  }
  if (record.degraded !== undefined) {
    const degraded = record.degraded as Record<string, unknown>;
    if (typeof degraded !== "object" || degraded === null) return false;
    if (!Number.isFinite(degraded.crashCount) || !Number.isFinite(degraded.at)) return false;
  }
  return true;
}
