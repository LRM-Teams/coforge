import type {
  AgentMessageDraftContent,
  AgentMessageDraftLookup,
  AgentMessageDraftStore,
} from "#src/persistence/agent-message-draft-store";

/** The draft while it is only in memory: the stored entry minus the file-only
 * `target`/`savedAt`. */
type InMemoryDraft = AgentMessageDraftContent & { reholdCount: number };

/** What `--send-draft` found for a target: the store's lookup, whose found draft may also be one
 * that lives only in memory. */
export type AgentInboxDraftLookup =
  | Exclude<AgentMessageDraftLookup, { status: "found" }>
  | { status: "found"; draft: InMemoryDraft };

/**
 * Draft continuation state: `content`, `attachmentIds`, `idempotencyKey`, `mentions`,
 * `reholdCount`, `seenUpToSeq`. The daemon owns the draft (the CLI is a thin client), so this is
 * the one place a held send is remembered between requests.
 */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, InMemoryDraft>();

  constructor(private readonly persistence?: AgentMessageDraftStore) {}

  async save(target: string, draft: AgentMessageDraftContent) {
    this.#drafts.set(target, { ...draft, reholdCount: 0 });
    await this.persistence?.save(target, draft);
  }

  async replace(target: string, draft: AgentMessageDraftContent & { reholdCount: number }) {
    this.#drafts.set(target, draft);
    await this.persistence?.replace(target, draft);
  }

  async draft(target: string): Promise<InMemoryDraft | undefined> {
    const lookup = await this.lookup(target);
    return lookup.status === "found" ? lookup.draft : undefined;
  }

  async lookup(target: string): Promise<AgentInboxDraftLookup> {
    if (this.persistence) return this.persistence.lookup(target);
    const draft = this.#drafts.get(target);
    return draft ? { status: "found", draft } : { status: "missing" };
  }

  /** Clears the draft only when it still belongs to the send with this key. */
  async clearIfIdempotencyKeyMatches(target: string, idempotencyKey: string): Promise<boolean> {
    if (this.persistence) {
      const cleared = await this.persistence.clearIfIdempotencyKeyMatches(target, idempotencyKey);
      if (cleared) this.#drafts.delete(target);
      return cleared;
    }
    if (this.#drafts.get(target)?.idempotencyKey !== idempotencyKey) return false;
    this.#drafts.delete(target);
    return true;
  }

  async clear(target: string) {
    this.#drafts.delete(target);
    await this.persistence?.clear(target);
  }
}
