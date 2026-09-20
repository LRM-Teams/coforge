import type { LocalMentionSelector } from "@lrm/coforge-sdk/internal";
import type {
  AgentMessageDraft,
  AgentMessageDraftStore,
} from "../persistence/agent-message-draft-store";

type InMemoryDraft = {
  content: string;
  reholdCount: number;
  attachmentIds?: readonly string[];
  mentions?: readonly LocalMentionSelector[];
};

/** Draft continuation state. */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, InMemoryDraft>();

  constructor(private readonly persistence?: AgentMessageDraftStore) {}

  async save(
    target: string,
    content: string,
    attachmentIds?: readonly string[],
    mentions?: readonly LocalMentionSelector[],
  ) {
    this.#drafts.set(target, { content, reholdCount: 0, attachmentIds, mentions });
    await this.persistence?.save(target, content, attachmentIds, mentions);
  }

  /** Raft's held-draft refresh: the same draft, one hold later. */
  async replace(
    target: string,
    content: string,
    attachmentIds?: readonly string[],
    mentions?: readonly LocalMentionSelector[],
  ) {
    const reholdCount = ((await this.draft(target))?.reholdCount ?? 0) + 1;
    this.#drafts.set(target, { content, reholdCount, attachmentIds, mentions });
    await this.persistence?.replace(target, content, reholdCount, attachmentIds, mentions);
  }

  async draft(target: string): Promise<AgentMessageDraft | InMemoryDraft | undefined> {
    return this.persistence ? this.persistence.load(target) : this.#drafts.get(target);
  }

  async clear(target: string) {
    this.#drafts.delete(target);
    await this.persistence?.clear(target);
  }
}
