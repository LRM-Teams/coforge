import type { LocalMentionSelector } from "@lrm/coforge-sdk/internal";
import type {
  AgentMessageDraft,
  AgentMessageDraftStore,
} from "../persistence/agent-message-draft-store";

type InMemoryDraft = {
  body: string;
  holdToken?: string;
  attachmentIds?: readonly string[];
  mentions?: readonly LocalMentionSelector[];
};

/** Draft continuation state. Web/backend exclusively decides freshness and --anyway authorization. */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, InMemoryDraft>();

  constructor(private readonly persistence?: AgentMessageDraftStore) {}

  async save(
    target: string,
    body: string,
    attachmentIds?: readonly string[],
    mentions?: readonly LocalMentionSelector[],
  ) {
    this.#drafts.set(target, { body, attachmentIds, mentions });
    await this.persistence?.save(target, body, undefined, attachmentIds, mentions);
  }

  async replace(
    target: string,
    body: string,
    holdToken: string,
    attachmentIds?: readonly string[],
    mentions?: readonly LocalMentionSelector[],
  ) {
    this.#drafts.set(target, { body, holdToken, attachmentIds, mentions });
    await this.persistence?.save(target, body, holdToken, attachmentIds, mentions);
  }

  async draft(target: string): Promise<AgentMessageDraft | InMemoryDraft | undefined> {
    return this.persistence ? this.persistence.load(target) : this.#drafts.get(target);
  }

  async clear(target: string) {
    this.#drafts.delete(target);
    await this.persistence?.clear(target);
  }
}
