import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

/**
 * How a provider's session accepts a delivery notice while a turn is already in progress.
 * - `steer`: the provider's own `AgentSession.notify()` safely handles busy delivery on its own
 *   (Claude holds it for a native boundary, Codex sends `turn/steer`, Pi/CoForge steer the live
 *   stream, Cursor queues text for its own next per-turn process, Kiro sends its own ACP
 *   `_session/steer` extension) without losing the turn in progress. The daemon keeps calling
 *   `notify()` as soon as a delivery is accepted, exactly as before this module existed.
 * - `queue_until_idle`: the provider's `notify()` has no safe busy path at all — sending it
 *   mid-turn starts a brand-new prompt and ends the running one. No provider is in this mode
 *   today (Kiro moved to `steer` once its own `_session/steer` extension was wired in); the mode
 *   and the daemon-level hold/flush machinery it drives stay in place for a future provider that
 *   needs it, and as the seam `notice-undelivered`'s fallback redelivery reuses (see
 *   `holdFallbackNotice`/`releaseFallbackNotices` below).
 */
export type AgentDeliveryMode = "steer" | "queue_until_idle";

/** Scope decision (ADR 0048): moving Claude/Codex/Pi steering into the daemon itself, so this
 * table could eventually replace every provider's own busy handling, is a later cleanup.
 * Exact-target focus is an additional gate shared by all providers. */
export const AGENT_DELIVERY_MODE: Readonly<Record<RuntimeProvider, AgentDeliveryMode>> = {
  [RUNTIME_PROVIDER.COFORGE]: "steer",
  [RUNTIME_PROVIDER.PI]: "steer",
  [RUNTIME_PROVIDER.CODEX]: "steer",
  [RUNTIME_PROVIDER.CLAUDE_CODE]: "steer",
  [RUNTIME_PROVIDER.CURSOR]: "steer",
  [RUNTIME_PROVIDER.KIRO]: "steer",
  [RUNTIME_PROVIDER.OPENCODE]: "steer",
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
  readonly #activeTarget = new Map<string, string>();
  readonly #held = new Map<string, AgentMessageDelivery[]>();
  /** App-item ids held while busy (ADR 0048, `DaemonRuntime#notifyAppItem`) — a separate,
   * app-inbox-owned notice, not an `AgentMessageDelivery`; kept apart from `#held` so the two
   * domains' storage never mixes. */
  readonly #heldAppItems = new Map<string, Set<string>>();
  /** Fallback notice text held for redelivery after a `steer` provider's own busy-delivery
   * protocol accepted a notice (`notify` resolved) but later learned it never actually reached
   * the model (ADR 0048's `notice-undelivered` event) — raw text, not an `AgentMessageDelivery`,
   * since the original delivery this text came from was already ACKed (or never had one, for an
   * App Inbox notice); redelivering it must never touch ACK bookkeeping again. */
  readonly #heldFallbackNotices = new Map<string, string[]>();
  /** An explicit hold from `hold()`, keyed by Agent; its value is an opaque marker a later PR
   * interprets (e.g. a backoff deadline). Presence alone means "held", regardless of busy/idle. */
  readonly #explicitHolds = new Map<string, unknown>();

  /** Records which delivery mode this Agent's current launch uses; call at every launch, since a
   * runtime config change (or a provider switch) can change it. */
  setProvider(agentId: string, provider: RuntimeProvider): void {
    this.setMode(agentId, AGENT_DELIVERY_MODE[provider]);
  }

  /**
   * The lower-level primitive `setProvider` calls through `AGENT_DELIVERY_MODE`. No
   * `RuntimeProvider` maps to `queue_until_idle` today (Kiro moved to `steer` once its own
   * `_session/steer` extension was wired in — ADR 0048), so this is also the only way to
   * exercise that mode's gating directly, for a future provider that needs it and for this
   * module's own tests.
   */
  setMode(agentId: string, mode: AgentDeliveryMode): void {
    this.#mode.set(agentId, mode);
  }

  /** Marks the Agent's runtime as mid-turn. Different targets wait; same-target steering follows the provider mode. */
  busy(agentId: string, target?: string): void {
    this.#busy.add(agentId);
    // Empty target reserves an unscoped recovery turn; live messages wait for it.
    if (target !== undefined) this.#activeTarget.set(agentId, target);
  }

  activeTarget(agentId: string): string | undefined {
    return this.#activeTarget.get(agentId) || undefined;
  }

  /** Marks the Agent idle and returns the oldest target’s held messages, preserving other targets.
   * Empty when nothing was held or an explicit hold (`hold`) is still in effect. */
  idle(agentId: string): AgentMessageDelivery[] {
    this.#busy.delete(agentId);
    this.#activeTarget.delete(agentId);
    if (this.#explicitHolds.has(agentId)) return [];
    return this.#drainTarget(agentId);
  }

  /** True when a delivery for this Agent must be held rather than notified immediately. */
  shouldHold(agentId: string, target?: string): boolean {
    if (this.#explicitHolds.has(agentId)) return true;
    if (!this.#busy.has(agentId)) return false;
    const activeTarget = this.#activeTarget.get(agentId);
    return (
      (activeTarget !== undefined && target !== activeTarget) ||
      this.#mode.get(agentId) === "queue_until_idle"
    );
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
   * Unconditionally drains and returns everything held for the Agent, ignoring busy/idle and any
   * explicit hold — for a caller that has already decided these held deliveries are redundant
   * (ADR 0048: a relaunch's `recover()` pass already told the Agent about the same canonical
   * unread state) and only needs them back to ACK each one, never to notify with them.
   */
  discardPending(agentId: string): AgentMessageDelivery[] {
    return this.#drain(agentId);
  }

  /** Records an app-item notice (`DaemonRuntime#notifyAppItem`) as held while busy. */
  holdAppItem(agentId: string, itemId: string): void {
    const items = this.#heldAppItems.get(agentId) ?? new Set<string>();
    items.add(itemId);
    this.#heldAppItems.set(agentId, items);
  }

  /** Drains and returns the app-item ids held for the Agent, for the caller to re-attempt
   * delivery of each — unconditionally, like `discardPending`; the caller re-checks `shouldHold`
   * itself for each item before actually notifying, so one still-busy item (e.g. a coalesced
   * delivery flush that just re-armed busy) re-holds itself rather than being lost. */
  releaseAppItems(agentId: string): string[] {
    const items = this.#heldAppItems.get(agentId);
    this.#heldAppItems.delete(agentId);
    return items ? [...items] : [];
  }

  /** Records a notice's text for redelivery once this Agent is next idle (ADR 0048,
   * `notice-undelivered`). Order is not meaningful here (unlike `enqueue`'s deliveries) — each
   * text is redelivered as its own independent `notify` call, never coalesced. */
  holdFallbackNotice(agentId: string, text: string): void {
    const list = this.#heldFallbackNotices.get(agentId) ?? [];
    list.push(text);
    this.#heldFallbackNotices.set(agentId, list);
  }

  /** Drains and returns the fallback notice texts held for the Agent — unconditionally, like
   * `discardPending`/`releaseAppItems`; the caller (`DaemonRuntime`) only calls this once the
   * Agent is genuinely idle (turn end), and redelivers each text as an ordinary `notify` call. */
  releaseFallbackNotices(agentId: string): string[] {
    const texts = this.#heldFallbackNotices.get(agentId);
    this.#heldFallbackNotices.delete(agentId);
    return texts ?? [];
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

  /** Clears an explicit hold and, if the Agent is not also busy, releases the oldest target
   * held for it (mirroring `idle`). */
  release(agentId: string): AgentMessageDelivery[] {
    this.#explicitHolds.delete(agentId);
    if (this.#busy.has(agentId)) return [];
    return this.#drainTarget(agentId);
  }

  /** An unexpected process exit: the running turn is gone, so busy no longer applies, but
   * anything held (deliveries, app items, and fallback notices alike) stays held for the next
   * launch (ADR 0048) — only explicit Stop (`clearAgent`) discards it. */
  onProcessExit(agentId: string): void {
    this.#busy.delete(agentId);
    this.#activeTarget.delete(agentId);
  }

  /** Explicit Stop: discards this Agent's held deliveries, app items, and fallback notices along
   * with the rest of its state. */
  clearAgent(agentId: string): void {
    this.#mode.delete(agentId);
    this.#busy.delete(agentId);
    this.#activeTarget.delete(agentId);
    this.#held.delete(agentId);
    this.#heldAppItems.delete(agentId);
    this.#heldFallbackNotices.delete(agentId);
    this.#explicitHolds.delete(agentId);
  }

  #drainTarget(agentId: string): AgentMessageDelivery[] {
    const list = this.#held.get(agentId) ?? [];
    const target = list[0]?.target;
    const batch = list.filter((message) => message.target === target);
    const remaining = list.filter((message) => message.target !== target);
    if (remaining.length) this.#held.set(agentId, remaining);
    else this.#held.delete(agentId);
    return batch;
  }

  #drain(agentId: string): AgentMessageDelivery[] {
    const list = this.#held.get(agentId) ?? [];
    this.#held.delete(agentId);
    return list;
  }
}
