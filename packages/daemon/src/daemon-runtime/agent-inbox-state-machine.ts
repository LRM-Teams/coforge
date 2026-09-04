import type {
  AgentMessageDraft,
  AgentMessageDraftStore,
} from "../persistence/agent-message-draft-store";

/** Draft continuation state. Web/backend exclusively decides freshness and --anyway authorization. */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, { body: string; holdToken?: string }>();

  constructor(private readonly persistence?: AgentMessageDraftStore) {}

  async save(target: string, body: string) {
    this.#drafts.set(target, { body });
    await this.persistence?.save(target, body);
  }

  async replace(target: string, body: string, holdToken: string) {
    this.#drafts.set(target, { body, holdToken });
    await this.persistence?.save(target, body, holdToken);
  }

  async draft(
    target: string,
  ): Promise<AgentMessageDraft | Readonly<{ body: string; holdToken?: string }> | undefined> {
    return this.persistence ? this.persistence.load(target) : this.#drafts.get(target);
  }

  async clear(target: string) {
    this.#drafts.delete(target);
    await this.persistence?.clear(target);
  }
}
