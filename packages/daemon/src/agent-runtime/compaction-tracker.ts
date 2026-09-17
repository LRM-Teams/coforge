/**
 * Tracks whether an Agent's runtime is mid-compaction, independent of which provider reported
 * it. Providers no longer decide when a compaction "episode" has started or finished - they just
 * relay the raw signal their protocol gives them, edge or not, and this tracker is the single
 * place that turns repeated/partial signals into "report once when it starts, then once when it
 * finishes" (previously duplicated per provider, e.g. Kiro's local `#compacting` de-dup).
 *
 * One instance is shared by the whole daemon runtime, keyed by agentId (an Agent has at most one
 * active launch's compaction in flight at a time, matching how `#lastBusyActivity` and friends in
 * runtime.ts are already keyed).
 */

/** How long a compaction can stay "active" with no finish signal before it is considered stale. */
export const COMPACTION_STALE_MS = 5 * 60_000;

type CompactionState =
  | { kind: "inactive" }
  | { kind: "active"; startedAt: number; watchdog: ReturnType<typeof setTimeout> | undefined };

export type CompactionStartResult = "started" | "already-active";
export type CompactionFinishResult = "finished" | "not-active";

export class CompactionTracker {
  readonly #states = new Map<string, CompactionState>();

  /**
   * @param onStale Called at most once per compaction episode, `COMPACTION_STALE_MS` after it
   * started, if it is still active by then. Today this is a single, clearly-marked no-op call
   * site (see runtime.ts) with a TODO: the SDK's `AgentActivityDetailKind` does not yet carry a
   * `compaction_stale` value (landing in a separate change), so there is nothing safe to
   * broadcast yet. Once that kind exists, wiring the visible notice is a one-line change at that
   * call site - this tracker's timer/state plumbing does not need to change.
   */
  constructor(private readonly onStale: (agentId: string) => void) {}

  /** Starts a compaction episode. A second start while one is already active is a no-op: the
   * caller must not re-announce it, matching the "report compacting once" contract. */
  start(agentId: string): CompactionStartResult {
    const state = this.#states.get(agentId);
    if (state?.kind === "active") return "already-active";
    const startedAt = Date.now();
    const watchdog = setTimeout(() => this.#markStale(agentId, startedAt), COMPACTION_STALE_MS);
    this.#states.set(agentId, { kind: "active", startedAt, watchdog });
    return "started";
  }

  /**
   * Ends a compaction episode, explicit or inferred. A no-op unless one is currently active, so
   * a finish signal with no matching start (or a second finish for the same episode) never
   * produces a visible Activity - the caller only announces "finished" when this returns
   * `"finished"`.
   */
  finish(agentId: string): CompactionFinishResult {
    const state = this.#states.get(agentId);
    if (!state || state.kind !== "active") return "not-active";
    clearTimeout(state.watchdog);
    this.#states.set(agentId, { kind: "inactive" });
    return "finished";
  }

  /** Clears an active compaction without a visible Activity (interrupted compaction is silent by
   * itself; the caller decides separately whether the interruption is otherwise reported). */
  interrupt(agentId: string): void {
    const state = this.#states.get(agentId);
    if (!state || state.kind !== "active") return;
    clearTimeout(state.watchdog);
    this.#states.set(agentId, { kind: "inactive" });
  }

  isActive(agentId: string): boolean {
    return this.#states.get(agentId)?.kind === "active";
  }

  /** Stops any pending watchdog and forgets this Agent's state. Must run on every launch
   * end/dispose so a torn-down Agent never leaks a timer, and so a later launch starts clean. */
  dispose(agentId: string): void {
    const state = this.#states.get(agentId);
    if (state?.kind === "active") clearTimeout(state.watchdog);
    this.#states.delete(agentId);
  }

  /** Disposes every tracked Agent; used on full daemon shutdown. */
  disposeAll(): void {
    for (const state of this.#states.values())
      if (state.kind === "active") clearTimeout(state.watchdog);
    this.#states.clear();
  }

  #markStale(agentId: string, startedAt: number): void {
    const state = this.#states.get(agentId);
    // Guards a watchdog from a previous episode firing after a new one has already begun, and a
    // watchdog outliving `finish`/`interrupt`/`dispose` (both already clear the timer, but a
    // timer already queued on the event loop when they ran must still no-op here).
    if (!state || state.kind !== "active" || state.startedAt !== startedAt) return;
    // One-shot: leaves `kind: "active"` so a second stale notice is never re-armed for the same
    // episode; only an explicit/inferred finish or a fresh `start()` changes state from here.
    this.#states.set(agentId, { kind: "active", startedAt, watchdog: undefined });
    this.onStale(agentId);
  }
}
