import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { LocalMentionSelector } from "@lrm/coforge-sdk/internal";

export const AGENT_MESSAGE_DRAFT_TTL_MS = 10 * 60 * 1_000;

export type AgentMessageDraft = Readonly<{
  target: string;
  content: string;
  /** How many times this draft has already been held. Reported to the server as
   * `draftReholdCount`, which is what makes `continueAnywaySuggested` true (Raft's draft state). */
  reholdCount: number;
  savedAt: number;
  attachmentIds?: readonly string[];
  mentions?: readonly LocalMentionSelector[];
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
      `coforge-cli-attested-send-${encodeIdentity(String(process.geteuid?.() ?? userInfo().username))}`,
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
      const found = fresh.find((draft) => draft.target === target);
      if (!found) return undefined;
      // A file written before Raft's draft shape was adopted still names its text `body` and has
      // simply never been held; carry it forward instead of losing an in-flight draft on upgrade.
      const legacy = found as { body?: string };
      return {
        target: found.target,
        content: found.content ?? legacy.body ?? "",
        reholdCount: found.reholdCount ?? 0,
        savedAt: found.savedAt,
        ...(found.attachmentIds ? { attachmentIds: found.attachmentIds } : {}),
        ...(found.mentions ? { mentions: found.mentions } : {}),
      };
    });
  }

  /** A fresh send saves a never-held draft; only `replace` (a hold) advances the count. */
  save(
    target: string,
    content: string,
    attachmentIds?: readonly string[],
    mentions?: readonly LocalMentionSelector[],
  ): Promise<void> {
    return this.#writeDraft(target, content, 0, attachmentIds, mentions);
  }

  #writeDraft(
    target: string,
    content: string,
    reholdCount: number,
    attachmentIds?: readonly string[],
    mentions?: readonly LocalMentionSelector[],
  ): Promise<void> {
    return this.#serialized(async () => {
      const draft = {
        target,
        content,
        reholdCount,
        ...(attachmentIds?.length ? { attachmentIds } : {}),
        ...(mentions?.length ? { mentions } : {}),
        savedAt: this.now(),
      };
      const drafts = (await this.#read()).filter((current) => current.target !== target);
      drafts.push(draft);
      await this.#write(drafts);
    });
  }

  /** Raft's held-draft refresh: the same text, one hold later. */
  replace(
    target: string,
    content: string,
    reholdCount: number,
    attachmentIds?: readonly string[],
    mentions?: readonly LocalMentionSelector[],
  ): Promise<void> {
    return this.#writeDraft(target, content, reholdCount, attachmentIds, mentions);
  }

  clear(target: string): Promise<void> {
    return this.#serialized(async () => {
      const drafts = (await this.#read()).filter((draft) => draft.target !== target);
      await this.#write(drafts);
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      await this.#prepareDirectories();
      return operation();
    };
    const result = this.#operation.then(guarded, guarded);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #prepareDirectories(): Promise<void> {
    for (const directory of [dirname(dirname(this.#path)), dirname(this.#path)]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const status = await lstat(directory);
      if (status.isSymbolicLink() || !status.isDirectory())
        throw new Error("Agent message draft directory must be a real directory");
      const uid = process.geteuid?.();
      if (uid !== undefined && status.uid !== uid)
        throw new Error("Agent message draft directory must be owned by the current user");
      await chmod(directory, 0o700);
    }
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
    (typeof draft.content === "string" ||
      // Pre-rename draft files named the text `body`; still a valid, readable draft.
      typeof (draft as { body?: unknown }).body === "string") &&
    // Older drafts predate `reholdCount`; a missing value is simply a never-held draft.
    (draft.reholdCount === undefined || typeof draft.reholdCount === "number") &&
    typeof draft.savedAt === "number" &&
    Number.isFinite(draft.savedAt) &&
    // Older drafts predate these fields; their absence is a valid, backward-compatible draft.
    (draft.attachmentIds === undefined ||
      (Array.isArray(draft.attachmentIds) &&
        draft.attachmentIds.every((id) => typeof id === "string"))) &&
    (draft.mentions === undefined ||
      (Array.isArray(draft.mentions) && draft.mentions.every(isMentionSelector)))
  );
}

function isMentionSelector(value: unknown): value is LocalMentionSelector {
  if (!value || typeof value !== "object") return false;
  const mention = value as Record<string, unknown>;
  return (
    (mention.type === "user" || mention.type === "agent") &&
    typeof mention.id === "string" &&
    typeof mention.name === "string"
  );
}

function encodeIdentity(identity: string): string {
  if (!identity) throw new Error("Agent message draft identity is required");
  return encodeURIComponent(identity).replaceAll(".", "%2E");
}
