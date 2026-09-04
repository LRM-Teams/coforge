import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const AGENT_MESSAGE_DRAFT_TTL_MS = 10 * 60 * 1_000;

export type AgentMessageDraft = Readonly<{
  target: string;
  body: string;
  holdToken?: string;
  savedAt: number;
}>;

/** Short-lived continuation state, isolated in one private file per Agent. */
export class AgentMessageDraftStore {
  readonly #path: string;
  #operation = Promise.resolve();

  constructor(
    agentId: string,
    rootDirectory = process.env.COFORGE_CLI_DRAFT_STATE_DIR ?? tmpdir(),
    private readonly now: () => number = Date.now,
  ) {
    if (!rootDirectory) throw new Error("Agent message draft state directory is required");
    this.#path = join(
      rootDirectory,
      "coforge-cli-attested-send",
      encodeIdentity(agentId),
      "continue-state.json",
    );
  }

  load(target: string): Promise<AgentMessageDraft | undefined> {
    return this.#serialized(async () => {
      const drafts = await this.#read();
      const fresh = drafts.filter(
        ({ savedAt }) => this.now() - savedAt <= AGENT_MESSAGE_DRAFT_TTL_MS,
      );
      if (fresh.length !== drafts.length) await this.#write(fresh);
      return fresh.find((draft) => draft.target === target);
    });
  }

  save(target: string, body: string, holdToken?: string): Promise<void> {
    return this.#serialized(async () => {
      const draft = {
        target,
        body,
        ...(holdToken ? { holdToken } : {}),
        savedAt: this.now(),
      };
      const drafts = (await this.#read()).filter((current) => current.target !== target);
      drafts.push(draft);
      await this.#write(drafts);
    });
  }

  clear(target: string): Promise<void> {
    return this.#serialized(async () => {
      const drafts = (await this.#read()).filter((draft) => draft.target !== target);
      await this.#write(drafts);
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #read(): Promise<AgentMessageDraft[]> {
    if (!(await Bun.file(this.#path).exists())) return [];
    let envelope: unknown;
    try {
      envelope = JSON.parse(await Bun.file(this.#path).text());
    } catch {
      throw new Error(`Agent message draft data is corrupt: ${this.#path}`);
    }
    if (!isDraftEnvelope(envelope))
      throw new Error(`Agent message draft data is corrupt: ${this.#path}`);
    return envelope.drafts;
  }

  async #write(drafts: readonly AgentMessageDraft[]): Promise<void> {
    if (drafts.length === 0) {
      await rm(this.#path, { force: true });
      return;
    }
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, drafts }) + "\n", { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function isDraftEnvelope(value: unknown): value is { version: 1; drafts: AgentMessageDraft[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.version === 1 && Array.isArray(envelope.drafts) && envelope.drafts.every(isDraft);
}

function isDraft(value: unknown): value is AgentMessageDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.target === "string" &&
    typeof draft.body === "string" &&
    (draft.holdToken === undefined || typeof draft.holdToken === "string") &&
    typeof draft.savedAt === "number" &&
    Number.isFinite(draft.savedAt)
  );
}

function encodeIdentity(identity: string): string {
  if (!identity) throw new Error("Agent message draft identity is required");
  return encodeURIComponent(identity).replaceAll(".", "%2E");
}
