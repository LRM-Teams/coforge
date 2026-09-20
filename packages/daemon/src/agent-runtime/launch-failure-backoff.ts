/**
 * Per-Agent launch-failure backoff (Raft 1.0.32 `SPAWN-FAIL BACKOFF`, anchored at
 * `apm:3596/4137`): each failed launch counts, and the next attempt waits an exponentially
 * growing, capped cooldown instead of burning immediately — "repeated wakes cannot burn one full
 * spawn attempt per delivery".
 *
 * Pure bookkeeping on purpose: no timers, no I/O, no knowledge of `AgentControl`. The caller
 * decides what to do with the computed cooldown (AgentControl schedules the retry, tests assert
 * the numbers directly). State lives in memory for this daemon instance only: a launch failure
 * is a fact about the local process/host, not something that should outlive the daemon that
 * observed it.
 */

/** First cooldown: one second. Matches Raft's ordinary-spawn base. */
export const LAUNCH_FAILURE_BACKOFF_BASE_MS = 1_000;
/** Cooldown ceiling: thirty seconds. Matches Raft's ordinary-spawn cap. */
export const LAUNCH_FAILURE_BACKOFF_CAP_MS = 30_000;
/**
 * One initial attempt plus at most (this - 1) automatic retries. With the base/cap above the
 * cooldowns are 1s, 2s, 4s, 8s, 16s, 30s — the cap is actually reached — for a ~61s total retry
 * window before the daemon reports `launch_failed` exactly as it did before this change. Bounded
 * (unlike Raft's capped-but-unbounded exponent) so a permanently broken launch configuration
 * cannot leave the server's Start operation in "starting" forever.
 */
export const LAUNCH_FAILURE_MAX_ATTEMPTS = 7;

export type LaunchFailureBackoffState = Readonly<{
  /** Consecutive failed launches for this Agent, including the one just recorded. */
  attempts: number;
  /** How long the caller must wait before the next attempt, in milliseconds. */
  cooldownMs: number;
  /** Absolute epoch-milliseconds time at which the next attempt becomes due. */
  untilMs: number;
}>;

/** `base * 2^(attempts - 1)`, capped. Raft's formula with threshold 0 (back off from the first
 * failure) and its exponent bound folded into the millisecond cap. */
export function launchFailureCooldownMs(
  attempts: number,
  baseMs: number = LAUNCH_FAILURE_BACKOFF_BASE_MS,
  capMs: number = LAUNCH_FAILURE_BACKOFF_CAP_MS,
): number {
  if (attempts < 1) return baseMs;
  // Bound the exponent before it overflows a float's exact-integer range; the minute cap below
  // is reached long before this matters.
  const exponent = Math.min(attempts - 1, 30);
  return Math.min(baseMs * 2 ** exponent, capMs);
}

export class LaunchFailureBackoff {
  readonly #failures = new Map<string, { attempts: number; untilMs: number }>();

  constructor(
    private readonly baseMs: number = LAUNCH_FAILURE_BACKOFF_BASE_MS,
    private readonly capMs: number = LAUNCH_FAILURE_BACKOFF_CAP_MS,
  ) {}

  /** Records one failed attempt for `agentId` and returns the cooldown the next attempt owes. */
  recordFailure(agentId: string, now: number = Date.now()): LaunchFailureBackoffState {
    const attempts = this.attempts(agentId) + 1;
    const cooldownMs = launchFailureCooldownMs(attempts, this.baseMs, this.capMs);
    const untilMs = now + cooldownMs;
    this.#failures.set(agentId, { attempts, untilMs });
    return { attempts, cooldownMs, untilMs };
  }

  /** Clears the streak after a successful launch (or an explicit Stop). Returns how many
   * consecutive failures were cleared, so the caller can narrate a recovery only when there was
   * one. */
  reset(agentId: string): number {
    const attempts = this.attempts(agentId);
    this.#failures.delete(agentId);
    return attempts;
  }

  attempts(agentId: string): number {
    return this.#failures.get(agentId)?.attempts ?? 0;
  }

  blockedUntil(agentId: string): number | undefined {
    return this.#failures.get(agentId)?.untilMs;
  }

  /** True while this Agent owes a cooldown before its next attempt. */
  isBlocked(agentId: string, now: number = Date.now()): boolean {
    const untilMs = this.blockedUntil(agentId);
    return untilMs !== undefined && untilMs > now;
  }

  clear(): void {
    this.#failures.clear();
  }
}
