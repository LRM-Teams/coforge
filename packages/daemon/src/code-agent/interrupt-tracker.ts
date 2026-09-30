/** The pending-interrupt bookkeeping the promise-based code agent sessions share (the Claude Code
 * provider and the per-turn session).
 *
 * `interrupt()` cannot settle when the turn's own `interrupt()` returns: the turn ends later, a
 * process can close, and a dispose can land while an interrupt is still pending. This holds the
 * pending slot plus the promise whose `resolve` and `reject` are handed to those later events.
 *
 * The session still owns its `#state` and decides when an interrupt applies; this owns only the
 * pending slot and the promise handed back to the caller. A session reports the events it already
 * observes: `settle()` when the interrupted turn is over, `fail()` when the session is disposed,
 * the process closes, or the delegation itself threw.
 */
export class InterruptTracker {
  #pending: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined;

  /** Whether an interrupt is waiting to be settled. */
  get isPending(): boolean {
    return this.#pending !== undefined;
  }

  /** Starts an interrupt and returns the promise its caller awaits. A second call while one is
   * pending coalesces onto the same promise rather than replacing it. */
  begin(): Promise<void> {
    if (this.#pending) return this.#pending.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#pending = { promise, resolve, reject };
    return promise;
  }

  /** Settles a pending interrupt: the turn it interrupted is over. */
  settle(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.resolve();
  }

  /** Fails a pending interrupt: the session was disposed, the process closed, or the delegation
   * threw. Rejects only when one is pending. */
  fail(error: Error): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
  }
}
