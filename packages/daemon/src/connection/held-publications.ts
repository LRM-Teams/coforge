/**
 * How many Message delivery notices a held buffer keeps before it keeps only each Agent's latest.
 * A notice wakes its Agent, and what the Agent then reads comes from the cloud's read boundary,
 * so each Agent's latest notice is always kept. A dropped notice is also never ACKed, so
 * it stays pending: the server republishes pending deliveries on the next accepted ready
 * (`readPendingAgentDeliveries`, which it runs before answering ready, so they arrive while ready
 * is still held), and an Agent that is not running recovers them from the read boundary.
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
    this.#replace(agentId, kind, item);
  }

  /** Holds an item nothing later supersedes. */
  add(item: Item): void {
    this.#held.set(`#${this.#next++}`, item);
  }

  /**
   * Holds a delivery notice. Past the cap, each Agent keeps only its latest notice: a newer one
   * replaces the Agent's earlier over-cap notice, which is dropped and counted. So one Agent's
   * backlog can never crowd out another Agent's only notice.
   */
  notice(agentId: string, item: Item): void {
    if (this.#notices < this.noticeCap) {
      this.#notices += 1;
      this.add(item);
      return;
    }
    if (this.#replace(agentId, "notice", item)) this.#dropped += 1;
  }

  /** Holds `item` as the Agent's latest of `kind`, in the newer arrival's place; returns whether
   * it replaced an earlier one. */
  #replace(agentId: string, kind: string, item: Item): boolean {
    const key = `${agentId}:${kind}`;
    const replaced = this.#held.delete(key);
    this.#held.set(key, item);
    return replaced;
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
