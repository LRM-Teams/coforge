/**
 * How many Message delivery notices a held buffer keeps. Past it a notice is dropped, which is
 * safe: a notice is ACKed only once the runtime handles it, so a dropped one stays pending and the
 * server publishes it again when this daemon's ready is accepted (`readPendingAgentDeliveries`
 * for a running Agent), or its Agent recovers it from the read boundary on its next start.
 */
export const HELD_NOTICE_CAP = 500;

/**
 * Publications held back while a ready handshake waits, which can be hours during an outage.
 * Control intents that a later one supersedes are kept only once per key (the latest start and
 * the latest stop of each Agent), and delivery notices are capped, so the buffer stays bounded
 * and a late replay does not act on intents the cloud has long since replaced.
 */
export class HeldPublications<Item> {
  readonly #held = new Map<string, Item>();
  #next = 0;
  #notices = 0;
  #dropped = 0;

  constructor(private readonly noticeCap = HELD_NOTICE_CAP) {}

  /** Holds an Agent's latest intent of one kind (its start, its stop, or its activity probe),
   * replacing the earlier one; it takes the newer arrival's place. A start and a stop are kept
   * apart, so a restart (stop, then start) survives. */
  latestFor(agentId: string, kind: "start" | "stop" | "probe", item: Item): void {
    const key = `${agentId}:${kind}`;
    this.#held.delete(key);
    this.#held.set(key, item);
  }

  /** Holds an item nothing later supersedes. */
  add(item: Item): void {
    this.#held.set(`#${this.#next++}`, item);
  }

  /** Holds a delivery notice, or drops and counts it past the cap. */
  notice(item: Item): void {
    if (this.#notices >= this.noticeCap) {
      this.#dropped += 1;
      return;
    }
    this.#notices += 1;
    this.add(item);
  }

  /** Everything held, in arrival order, and how many notices were dropped; empties the buffer. */
  take(): { items: Item[]; dropped: number } {
    const taken = { items: [...this.#held.values()], dropped: this.#dropped };
    this.#held.clear();
    this.#notices = 0;
    this.#dropped = 0;
    return taken;
  }
}
