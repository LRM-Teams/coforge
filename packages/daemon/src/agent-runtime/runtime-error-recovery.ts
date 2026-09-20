/**
 * Per-Agent bookkeeping for a retryable runtime error observed mid-turn (a provider's `error`
 * event whose classified retry decision is `retry` — see `runtime-error-classification.ts`).
 * This is deliberately not about spawn failures: `agent-runtime/launch-failure-backoff.ts` (ADR
 * 0054) already owns the cooldown before a *launch* attempt even reaches a running process; this
 * module only starts once a process is up and a turn fails.
 *
 * Pure bookkeeping on purpose, matching `LaunchFailureBackoff`'s shape: no timers, no I/O. The
 * caller (`daemon-runtime/runtime.ts`) decides what the computed delay means — releasing
 * `AgentDeliveryQueue`'s explicit hold — and owns the actual timer.
 *
 * Two independent streaks live here, both reset only by a genuinely successful turn:
 * - `RuntimeErrorDeliveryBackoff` counts consecutive retryable failures for an Agent, regardless
 *   of which failure text caused each one, and computes the exponential/jittered delay before the
 *   next held delivery is released.
 * - `RuntimeErrorFingerprintFence` counts consecutive failures that carry the *same* fingerprint
 *   (agent-runtime/runtime-error-activity.ts's `fingerprintRuntimeError`). Backing off forever at
 *   the delivery backoff's cap would otherwise retry an Agent whose runtime is stuck on the exact
 *   same failure indefinitely; once the same fingerprint repeats
 *   `RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD` times in a row, the caller stops retrying that
 *   fingerprint instead of holding forever.
 */

/** First delivery-backoff delay: ten seconds. */
export const RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS = 10_000;
/** Delivery-backoff ceiling: five minutes. */
export const RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS = 5 * 60_000;
/** Extra delay added on top of the capped exponential delay, as a fraction of it, drawn from an
 * injectable random source so a computed delay is deterministic in tests. */
export const RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO = 0.1;
/** Consecutive same-fingerprint failures before the caller stops retrying that fingerprint. */
export const RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD = 3;

export type RuntimeErrorDeliveryBackoffOptions = Readonly<{
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  /** Returns a value in `[0, 1)`; defaults to `Math.random`. Tests inject a fixed source so the
   * computed delay is exact instead of a range. */
  jitterRandom?: () => number;
}>;

/** `base * 2^(attempts - 1)`, capped, plus up to `jitterRatio` of the capped delay. */
export function runtimeErrorDeliveryBackoffDelayMs(
  attempts: number,
  options: RuntimeErrorDeliveryBackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS;
  const jitterRatio = options.jitterRatio ?? RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO;
  const jitterRandom = options.jitterRandom ?? Math.random;
  // Bound the exponent before it overflows a float's exact-integer range; the cap below is
  // reached long before this matters.
  const exponent = Math.min(Math.max(0, attempts - 1), 30);
  const cappedDelayMs = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitterUnit = jitterRandom();
  const boundedJitterUnit = Number.isFinite(jitterUnit) ? Math.max(0, Math.min(1, jitterUnit)) : 0;
  const jitterMs = Math.floor(cappedDelayMs * jitterRatio * boundedJitterUnit);
  return Math.min(maxMs, cappedDelayMs + jitterMs);
}

export type RuntimeErrorDeliveryBackoffState = Readonly<{
  attempts: number;
  delayMs: number;
  untilMs: number;
}>;

export class RuntimeErrorDeliveryBackoff {
  readonly #attempts = new Map<string, number>();

  constructor(private readonly options: RuntimeErrorDeliveryBackoffOptions = {}) {}

  /** Records one retryable failure for `agentId` and returns the delay the next release owes. */
  recordFailure(agentId: string, now: number = Date.now()): RuntimeErrorDeliveryBackoffState {
    const attempts = this.attempts(agentId) + 1;
    this.#attempts.set(agentId, attempts);
    const delayMs = runtimeErrorDeliveryBackoffDelayMs(attempts, this.options);
    return { attempts, delayMs, untilMs: now + delayMs };
  }

  /** Clears the streak after a successful turn. Returns how many consecutive failures were
   * cleared, so the caller can narrate a recovery only when there was one. */
  reset(agentId: string): number {
    const attempts = this.attempts(agentId);
    this.#attempts.delete(agentId);
    return attempts;
  }

  attempts(agentId: string): number {
    return this.#attempts.get(agentId) ?? 0;
  }

  clear(): void {
    this.#attempts.clear();
  }
}

export type RuntimeErrorFingerprintFenceState = Readonly<{
  fingerprint: string;
  attempts: number;
  fenced: boolean;
}>;

export class RuntimeErrorFingerprintFence {
  readonly #state = new Map<string, { fingerprint: string; attempts: number }>();

  constructor(
    private readonly threshold: number = RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD,
  ) {}

  /** Records one retryable failure carrying `fingerprint` for `agentId`. A fingerprint different
   * from the one last seen restarts the streak at one, matching a brand-new problem rather than a
   * repeat of the last one. */
  note(agentId: string, fingerprint: string): RuntimeErrorFingerprintFenceState {
    const existing = this.#state.get(agentId);
    const attempts = existing && existing.fingerprint === fingerprint ? existing.attempts + 1 : 1;
    this.#state.set(agentId, { fingerprint, attempts });
    return { fingerprint, attempts, fenced: attempts >= this.threshold };
  }

  /** Clears the streak after a successful turn. */
  reset(agentId: string): void {
    this.#state.delete(agentId);
  }

  clear(): void {
    this.#state.clear();
  }
}

/** English detail text for a tripped fingerprint fence: names the streak length and the last
 * error, and gives the one thing that actually recovers it — the daemon has no finer-grained
 * user-facing recovery flow for this yet (that is a later CR's territory), so the only truthful
 * instruction here is to restart the Agent once the underlying issue is fixed. */
export function runtimeErrorFingerprintFenceDetail(
  state: RuntimeErrorFingerprintFenceState,
  lastErrorMessage: string,
): string {
  return `Runtime stopped retrying after ${state.attempts} consecutive failures with the same underlying error. Last error: ${lastErrorMessage} Restart this Agent once the issue is fixed.`;
}
