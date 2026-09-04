/** Volatile draft cache. Web/backend exclusively decides freshness and --anyway authorization. */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, { body: string; holdToken?: string }>();

  save(target: string, body: string) {
    this.#drafts.set(target, { body });
  }

  replace(target: string, body: string, holdToken: string) {
    this.#drafts.set(target, { body, holdToken });
  }

  draft(target: string): Readonly<{ body: string; holdToken?: string }> | undefined {
    return this.#drafts.get(target);
  }

  clear(target: string) {
    this.#drafts.delete(target);
  }
}
