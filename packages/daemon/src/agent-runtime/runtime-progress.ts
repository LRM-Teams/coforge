/**
 * Turns a provider's content-free "I am still alive" pings into the `runtime_progress` Activity,
 * without spamming a display that already shows the Agent as busy.
 *
 * Replaces the old fixed-interval rate limit (`RUNTIME_PROGRESS_RATE_LIMIT_MS` in runtime.ts):
 * instead of "at most one every N seconds", the rule is "announce only while the Agent does not
 * already look busy". Once something else (a tool call, streamed text, a compaction notice, ...)
 * has made the Agent visibly busy, further progress pings only refresh liveness bookkeeping - the
 * caller decides "already busy" from `#lastBusyActivity` (see runtime.ts), so this tracker itself
 * carries no Activity/detail-kind knowledge and stays trivially testable.
 */
export class RuntimeProgressTracker {
  readonly #lastObservedAtMs = new Map<string, number>();

  /**
   * @param agentId The Agent this progress ping belongs to.
   * @param alreadyBusy Whether the Agent's last announced Activity for the current launch is
   * already a visible busy kind (working/thinking equivalent). When true, `announce` is not
   * called - the ping still refreshes liveness bookkeeping.
   * @param announce Called synchronously, at most once, when the ping should become a visible
   * `runtime_progress` Activity.
   */
  observe(agentId: string, alreadyBusy: boolean, announce: () => void): void {
    this.#lastObservedAtMs.set(agentId, Date.now());
    if (!alreadyBusy) announce();
  }

  /** The last time this Agent's runtime reported any progress, announced or suppressed. */
  lastObservedAtMs(agentId: string): number | undefined {
    return this.#lastObservedAtMs.get(agentId);
  }

  /** Forgets this Agent's liveness bookkeeping; run on every launch end/dispose. */
  dispose(agentId: string): void {
    this.#lastObservedAtMs.delete(agentId);
  }

  /** Disposes every tracked Agent; used on full daemon shutdown. */
  disposeAll(): void {
    this.#lastObservedAtMs.clear();
  }
}
