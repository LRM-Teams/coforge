import type {
  AgentMessageDraftContent,
  AgentMessageDraftStore,
} from "../persistence/agent-message-draft-store";

/** The draft while it is only in memory: Raft's entry minus the file-only `savedAt`. */
type InMemoryDraft = AgentMessageDraftContent & { reholdCount: number };

/**
 * Draft continuation state, shaped like Raft's `continue-state.json` entry: `content`,
 * `attachmentIds`, `mentions`, `reholdCount`, `seenUpToSeq`. The daemon owns the draft (the CLI is
 * a thin client), so this is the one place a held send is remembered between requests.
 */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, InMemoryDraft>();

  constructor(private readonly persistence?: AgentMessageDraftStore) {}

  async save(target: string, draft: AgentMessageDraftContent) {
    const saved: InMemoryDraft = { ...draft, reholdCount: 0 };
    this.#drafts.set(target, saved);
    await this.persistence?.save(target, draft);
  }

  async replace(target: string, draft: AgentMessageDraftContent & { reholdCount: number }) {
    this.#drafts.set(target, { ...draft, reholdCount: draft.reholdCount });
    await this.persistence?.replace(target, draft);
  }

  async draft(target: string): Promise<InMemoryDraft | undefined> {
    if (!this.persistence) return this.#drafts.get(target);
    const persisted = await this.persistence.load(target);
    if (!persisted) return undefined;
    return {
      content: persisted.content,
      reholdCount: persisted.reholdCount,
      ...(persisted.attachmentIds ? { attachmentIds: persisted.attachmentIds } : {}),
      ...(persisted.mentions ? { mentions: persisted.mentions } : {}),
      ...(persisted.seenUpToSeq !== undefined ? { seenUpToSeq: persisted.seenUpToSeq } : {}),
    };
  }

  async clear(target: string) {
    this.#drafts.delete(target);
    await this.persistence?.clear(target);
  }
}
