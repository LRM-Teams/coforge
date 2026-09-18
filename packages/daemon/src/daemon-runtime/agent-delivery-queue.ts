import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

/**
 * How a provider's session accepts a delivery notice while a turn is already in progress.
 * - `steer`: the provider's own `AgentSession.notify()` safely handles busy delivery on its own
 *   (Claude holds it for a native boundary, Codex sends `turn/steer`, Pi/CoForge steer the live
 *   stream, Cursor queues text for its own next per-turn process) without losing the turn in
 *   progress. The daemon keeps calling `notify()` as soon as a delivery is accepted, exactly as
 *   before this module existed.
 * - `queue_until_idle`: the provider's `notify()` has no safe busy path — sending it mid-turn
 *   starts a brand-new prompt and ends the running one (observed for Kiro's ACP `session/prompt`,
 *   2026-09-18). This module holds the notice at the daemon layer instead, until the Agent is
 *   next idle.
 */
export type AgentDeliveryMode = "steer" | "queue_until_idle";

/** Scope decision (ADR 0048): moving Claude/Codex/Pi steering into the daemon itself, so this
 * table could eventually replace every provider's own busy handling, is a later cleanup. This PR
 * only gates the providers that have no safe busy path today. */
export const AGENT_DELIVERY_MODE: Readonly<Record<RuntimeProvider, AgentDeliveryMode>> = {
  [RUNTIME_PROVIDER.COFORGE]: "steer",
  [RUNTIME_PROVIDER.PI]: "steer",
  [RUNTIME_PROVIDER.CODEX]: "steer",
  [RUNTIME_PROVIDER.CLAUDE_CODE]: "steer",
  [RUNTIME_PROVIDER.CURSOR]: "steer",
  [RUNTIME_PROVIDER.KIRO]: "queue_until_idle",
};

/**
 * Daemon-owned per-Agent delivery queue (ADR 0048). Decides, per Agent, whether a delivery must
 * be held rather than reaching `AgentSession.notify()` right now, and holds it until it can be
 * released. `daemon-runtime/agent-message-attention-index.ts` is the only caller that currently
 * consults it (via the `shouldHold`/`enqueue` seam passed into its constructor) and the only one
 * that flushes held deliveries (`flush`, reusing its own coalesced-notice wording).
 *
 * This module also exposes the seams later PRs in the same series attach to, without
 * implementing their behavior: `hold`/`release` for an explicit pause (error backoff, the
 * 3-strike fence, stall recovery), and `pending`/`hasQueued` for carrying held deliveries into a
 * relaunch or deciding a stalled Agent needs help. Keeping them here now, even unused by this
 * PR's own runtime wiring, avoids re-deriving this state's ownership later.
 */
export class AgentDeliveryQueue {
  readonly #mode = new Map<string, AgentDeliveryMode>();
  readonly #busy = new Set<string>();
  readonly #held = new Map<string, AgentMessageDelivery[]>();
  /** An explicit hold from `hold()`, keyed by Agent; its value is an opaque marker a later PR
   * interprets (e.g. a backoff deadline). Presence alone means "held", regardless of busy/idle. */
  readonly #explicitHolds = new Map<string, unknown>();

  /** Records which delivery mode this Agent's current launch uses; call at every launch, since a
   * runtime config change (or a provider switch) can change it. */
  setProvider(agentId: string, provider: RuntimeProvider): void {
    this.#mode.set(agentId, AGENT_DELIVERY_MODE[provider]);
  }

  /** Marks the Agent's runtime as mid-turn. Only `queue_until_idle` providers gate on this. */
  busy(agentId: string): void {
    this.#busy.add(agentId);
  }

  /** Marks the Agent idle and returns everything held for it, oldest first, clearing the hold.
   * Empty when nothing was held or an explicit hold (`hold`) is still in effect. */
  idle(agentId: string): AgentMessageDelivery[] {
    this.#busy.delete(agentId);
    if (this.#explicitHolds.has(agentId)) return [];
    return this.#drain(agentId);
  }

  /** True when a delivery for this Agent must be held rather than notified immediately. */
  shouldHold(agentId: string): boolean {
    if (this.#explicitHolds.has(agentId)) return true;
    return this.#mode.get(agentId) === "queue_until_idle" && this.#busy.has(agentId);
  }

  /**
   * Records a delivery as held. The attention index is the only caller and already owns
   * deliveryId dedupe for a *first* delivery (only a not-yet-notified resend of an
   * already-accepted deliveryId — a distinct request, its own requestId — reaches this while
   * held); every held request is flushed and ACKed once, so none is silently dropped even when
   * its deliveryId repeats.
   */
  enqueue(agentId: string, message: AgentMessageDelivery): void {
    const list = this.#held.get(agentId) ?? [];
    list.push(message);
    this.#held.set(agentId, list);
  }

  /** Everything currently held for the Agent, oldest first — read-only; for a later PR carrying
   * held deliveries into a relaunch. */
  pending(agentId: string): readonly AgentMessageDelivery[] {
    return this.#held.get(agentId) ?? [];
  }

  /** For a later PR's stall-recovery trigger: true while this Agent has at least one held,
   * undelivered notice. */
  hasQueued(agentId: string): boolean {
    return (this.#held.get(agentId)?.length ?? 0) > 0;
  }

  /**
   * Explicit hold seam for later PRs (error backoff, the 3-strike fence, stall recovery): while
   * held, `shouldHold` is true regardless of busy/idle state. `until` is an opaque marker a later
   * PR interprets; this PR only stores and clears it — it does not itself schedule an automatic
   * release.
   */
  hold(agentId: string, until?: unknown): void {
    this.#explicitHolds.set(agentId, until ?? true);
  }

  /** Clears an explicit hold and, if the Agent is not also busy, returns and clears everything
   * held for it (mirroring `idle`). */
  release(agentId: string): AgentMessageDelivery[] {
    this.#explicitHolds.delete(agentId);
    if (this.#busy.has(agentId)) return [];
    return this.#drain(agentId);
  }

  /** An unexpected process exit: the running turn is gone, so busy no longer applies, but
   * anything held stays held for the next launch (ADR 0048) — only explicit Stop (`clearAgent`)
   * discards it. */
  onProcessExit(agentId: string): void {
    this.#busy.delete(agentId);
  }

  /** Explicit Stop: discards this Agent's held deliveries along with the rest of its state. */
  clearAgent(agentId: string): void {
    this.#mode.delete(agentId);
    this.#busy.delete(agentId);
    this.#held.delete(agentId);
    this.#explicitHolds.delete(agentId);
  }

  #drain(agentId: string): AgentMessageDelivery[] {
    const list = this.#held.get(agentId) ?? [];
    this.#held.delete(agentId);
    return list;
  }
}
