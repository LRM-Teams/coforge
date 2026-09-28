import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { LocalMentionSelector } from "@lrm/coforge-sdk/internal";
import { escapePathIdentity } from "./path-scope";

export const AGENT_MESSAGE_DRAFT_TTL_MS = 10 * 60 * 1_000;

/**
 * The continuation state of one held send — exactly the fields Raft's `setSavedDraft`
 * (`continue-state.json`) writes (1.0.32 bundle 753200-753235): `content`, `attachmentIds`,
 * `mentions`, `savedAt`, `reholdCount`, `seenUpToSeq`.
 */
export type AgentMessageDraftContent = Readonly<{
  content: string;
  attachmentIds?: readonly string[];
  mentions?: readonly LocalMentionSelector[];
  /** Raft's `seenUpToSeq`: the reviewed frontier this draft already accounts for. Carried into the
   * resend so the context the held notice presented is not presented — or held — twice. */
  seenUpToSeq?: number;
}>;

export type AgentMessageDraft = AgentMessageDraftContent &
  Readonly<{
    target: string;
    /** How many times this draft has already been held. Reported to the server as
     * `draftReholdCount`, which is what makes `continueAnywaySuggested` true (Raft's draft state). */
    reholdCount: number;
    savedAt: number;
  }>;

/**
 * Short-lived continuation state, isolated in one private file per Agent.
 *
 * The file shape is Raft's `continue-state.json`: a single `targets` map keyed by the message
 * target, each entry holding that target's draft. `target` is the key, never a field of the entry,
 * and expired entries are dropped on read, both as Raft's `getSavedDraft`/`setSavedDraft` do.
 */
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
      return drafts.get(target);
    });
  }

  /** A fresh send saves a never-held draft; only `replace` (a hold) advances the count. */
  save(target: string, draft: AgentMessageDraftContent): Promise<void> {
    return this.#writeDraft(target, draft, 0);
  }

  /** Raft's held-draft refresh: the same content, one hold later, at the reviewed frontier. */
  replace(
    target: string,
    draft: AgentMessageDraftContent & { reholdCount: number },
  ): Promise<void> {
    return this.#writeDraft(target, draft, draft.reholdCount);
  }

  clear(target: string): Promise<void> {
    return this.#serialized(async () => {
      const drafts = await this.#read();
      drafts.delete(target);
      await this.#write(drafts);
    });
  }

  #writeDraft(target: string, draft: AgentMessageDraftContent, reholdCount: number): Promise<void> {
    return this.#serialized(async () => {
      const drafts = await this.#read();
      drafts.set(target, {
        target,
        content: draft.content,
        reholdCount,
        ...(draft.attachmentIds?.length ? { attachmentIds: draft.attachmentIds } : {}),
        ...(draft.mentions?.length ? { mentions: draft.mentions } : {}),
        ...(draft.seenUpToSeq !== undefined ? { seenUpToSeq: draft.seenUpToSeq } : {}),
        savedAt: this.now(),
      });
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

  async #read(): Promise<Map<string, AgentMessageDraft>> {
    if (!(await Bun.file(this.#path).exists())) return new Map();
    let envelope: unknown;
    try {
      envelope = JSON.parse(await Bun.file(this.#path).text());
    } catch {
      throw new Error(`Agent message draft data is corrupt: ${this.#path}`);
    }
    const drafts = readDraftEntries(envelope);
    if (!drafts) throw new Error(`Agent message draft data is corrupt: ${this.#path}`);
    const fresh = new Map(
      [...drafts].filter(([, draft]) => this.now() - draft.savedAt <= AGENT_MESSAGE_DRAFT_TTL_MS),
    );
    if (fresh.size !== drafts.size) await this.#write(fresh);
    return fresh;
  }

  async #write(drafts: ReadonlyMap<string, AgentMessageDraft>): Promise<void> {
    if (drafts.size === 0) {
      await rm(this.#path, { force: true });
      return;
    }
    const targets: Record<string, unknown> = {};
    for (const [target, draft] of drafts) {
      targets[target] = {
        content: draft.content,
        // Raft writes the array even when the send carried no attachments; the read side treats an
        // empty or absent list the same way.
        attachmentIds: [...(draft.attachmentIds ?? [])],
        ...(draft.mentions?.length ? { mentions: draft.mentions } : {}),
        savedAt: draft.savedAt,
        reholdCount: draft.reholdCount,
        ...(draft.seenUpToSeq !== undefined ? { seenUpToSeq: draft.seenUpToSeq } : {}),
      };
    }
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ targets }) + "\n", { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/**
 * Reads either Raft's `{ targets: { … } }` file or the daemon's older `{ version, drafts: [ … ] }`
 * envelope (whose entries named their text `body` and could carry a dropped `holdToken`), so an
 * in-flight draft survives the upgrade instead of being lost.
 */
function readDraftEntries(value: unknown): Map<string, AgentMessageDraft> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  const drafts = new Map<string, AgentMessageDraft>();
  if (Array.isArray(envelope.drafts)) {
    if (envelope.version !== 1) return undefined;
    for (const entry of envelope.drafts) {
      const target =
        entry &&
        typeof entry === "object" &&
        typeof (entry as { target?: unknown }).target === "string"
          ? (entry as { target: string }).target
          : undefined;
      const draft = readDraft(entry, target);
      if (!draft) return undefined;
      drafts.set(draft.target, draft);
    }
    return drafts;
  }
  const targets = envelope.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return undefined;
  for (const [target, entry] of Object.entries(targets)) {
    const draft = readDraft(entry, target);
    if (!draft) return undefined;
    drafts.set(target, draft);
  }
  return drafts;
}

/** One draft entry, tolerating a missing `reholdCount`/`seenUpToSeq` and the pre-rename `body`. */
function readDraft(value: unknown, target: string | undefined): AgentMessageDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (target === undefined) return undefined;
  const draft = value as Record<string, unknown>;
  const content = typeof draft.content === "string" ? draft.content : draft.body;
  if (typeof content !== "string") return undefined;
  if (typeof draft.savedAt !== "number" || !Number.isFinite(draft.savedAt)) return undefined;
  if (draft.reholdCount !== undefined && typeof draft.reholdCount !== "number") return undefined;
  if (draft.seenUpToSeq !== undefined && typeof draft.seenUpToSeq !== "number") return undefined;
  const attachmentIds = Array.isArray(draft.attachmentIds)
    ? draft.attachmentIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const mentions = Array.isArray(draft.mentions)
    ? draft.mentions.filter(isMentionSelector)
    : undefined;
  if (Array.isArray(draft.mentions) && mentions?.length !== draft.mentions.length) return undefined;
  return {
    target,
    content,
    reholdCount: typeof draft.reholdCount === "number" ? draft.reholdCount : 0,
    savedAt: draft.savedAt,
    ...(attachmentIds?.length ? { attachmentIds } : {}),
    ...(mentions?.length ? { mentions } : {}),
    ...(typeof draft.seenUpToSeq === "number" ? { seenUpToSeq: draft.seenUpToSeq } : {}),
  };
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
  return escapePathIdentity(identity);
}
