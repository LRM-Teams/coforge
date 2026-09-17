import type { LocalMentionSelector } from "@lrm/coforge-sdk/internal";
import type {
  AgentMessageDraft,
  AgentMessageDraftStore,
} from "../persistence/agent-message-draft-store";

type InMemoryDraft = {
  body: string;
  holdToken?: string;
  attachmentId?: string;
  mentions?: readonly LocalMentionSelector[];
};

/** Draft continuation state. Web/backend exclusively decides freshness and --anyway authorization. */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, InMemoryDraft>();

  constructor(private readonly persistence?: AgentMessageDraftStore) {}

  async save(
    target: string,
    body: string,
    attachmentId?: string,
    mentions?: readonly LocalMentionSelector[],
  ) {
    this.#drafts.set(target, { body, attachmentId, mentions });
    await this.persistence?.save(target, body, undefined, attachmentId, mentions);
  }

  async replace(
    target: string,
    body: string,
    holdToken: string,
    attachmentId?: string,
    mentions?: readonly LocalMentionSelector[],
  ) {
    this.#drafts.set(target, { body, holdToken, attachmentId, mentions });
    await this.persistence?.save(target, body, holdToken, attachmentId, mentions);
  }

  async draft(target: string): Promise<AgentMessageDraft | InMemoryDraft | undefined> {
    return this.persistence ? this.persistence.load(target) : this.#drafts.get(target);
  }

  async clear(target: string) {
    this.#drafts.delete(target);
    await this.persistence?.clear(target);
  }
}
