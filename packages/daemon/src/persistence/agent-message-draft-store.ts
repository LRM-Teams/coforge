import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { LocalMentionSelector } from "@lrm/coforge-sdk/internal";
import { escapePathIdentity } from "./path-scope";

export const AGENT_MESSAGE_DRAFT_TTL_MS = 10 * 60 * 1_000;

/**
 * The continuation state of one held send — the fields Raft's `setSavedDraft`
 * (`continue-state.json`) writes: `content`, `attachmentIds`, `idempotencyKey`, `mentions`,
 * `savedAt`, `reholdCount`, `seenUpToSeq`.
 */
export type AgentMessageDraftContent = Readonly<{
  content: string;
  attachmentIds?: readonly string[];
  /** The idempotency key of the logical send this draft belongs to. Every send of the draft
   * (`--send-draft`, the same-key replay after a reconciliation) reuses it, so the server can never
   * commit the same logical send twice. An entry without one names no send and reads as missing. */
  idempotencyKey: string;
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

/** What a lookup found for one target. An expired draft is reported once, with its last body, and
 * removed; a later lookup reports it `missing`. */
export type AgentMessageDraftLookup =
  | { status: "found"; draft: AgentMessageDraft }
  | { status: "missing" }
  | { status: "expired"; content: string; savedAt: number };

/**
 * Short-lived continuation state, isolated in one private file per Agent.
 *
 * The file shape is Raft's `continue-state.json`: a single `targets` map keyed by the message
 * target, each entry holding that target's draft. `target` is the key, never a field of the entry.
 * As in Raft's `lookupSavedDraft`, only a lookup removes an expired entry, and only its own
 * target's: `--send-draft` can then tell an expired draft from one that never existed, and a write
 * for one target never drops another target's expired draft (or its last body).
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

  lookup(target: string): Promise<AgentMessageDraftLookup> {
    return this.#serialized(async () => {
      const drafts = await this.#read();
      const draft = drafts.get(target);
      if (!draft) return { status: "missing" };
      if (!this.#expired(draft)) return { status: "found", draft };
      drafts.delete(target);
      await this.#write(drafts);
      return { status: "expired", content: draft.content, savedAt: draft.savedAt };
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

  /** Raft's clear after an accepted send: only the send whose key the draft holds consumes it, so
   * an older send accepted late never removes a newer draft. Returns whether it cleared. */
  clearIfIdempotencyKeyMatches(target: string, idempotencyKey: string): Promise<boolean> {
    return this.#serialized(async () => {
      const drafts = await this.#read();
      const draft = drafts.get(target);
      // An expired draft is left for `--send-draft` to report (and hand back) as expired.
      if (!draft || this.#expired(draft) || draft.idempotencyKey !== idempotencyKey) return false;
      drafts.delete(target);
      await this.#write(drafts);
      return true;
    });
  }

  #writeDraft(target: string, draft: AgentMessageDraftContent, reholdCount: number): Promise<void> {
    return this.#serialized(async () => {
      const drafts = await this.#read();
      drafts.set(target, {
        target,
        content: draft.content,
        idempotencyKey: draft.idempotencyKey,
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

  #expired(draft: AgentMessageDraft): boolean {
    return this.now() - draft.savedAt > AGENT_MESSAGE_DRAFT_TTL_MS;
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
    return drafts;
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
        idempotencyKey: draft.idempotencyKey,
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
 * Reads Raft's `{ targets: { … } }` file. An entry without an idempotency key names no logical send,
 * so it is left out (and so dropped by the next write).
 */
function readDraftEntries(value: unknown): Map<string, AgentMessageDraft> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const targets = (value as Record<string, unknown>).targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return undefined;
  const drafts = new Map<string, AgentMessageDraft>();
  for (const [target, entry] of Object.entries(targets)) {
    const draft = readDraft(entry, target);
    if (draft === "invalid") return undefined;
    if (draft) drafts.set(target, draft);
  }
  return drafts;
}

/** One draft entry, tolerating a missing `reholdCount`/`seenUpToSeq`; `undefined` when it names no
 * send (no key), `"invalid"` when the file is corrupt. */
function readDraft(value: unknown, target: string): AgentMessageDraft | "invalid" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const draft = value as Record<string, unknown>;
  if (typeof draft.content !== "string") return "invalid";
  if (typeof draft.savedAt !== "number" || !Number.isFinite(draft.savedAt)) return "invalid";
  if (draft.reholdCount !== undefined && typeof draft.reholdCount !== "number") return "invalid";
  if (draft.seenUpToSeq !== undefined && typeof draft.seenUpToSeq !== "number") return "invalid";
  // Keys are compared exactly as written; a blank one names no send.
  if (typeof draft.idempotencyKey !== "string" || draft.idempotencyKey.trim().length === 0)
    return undefined;
  const idempotencyKey = draft.idempotencyKey;
  const attachmentIds = Array.isArray(draft.attachmentIds)
    ? draft.attachmentIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const mentions = Array.isArray(draft.mentions)
    ? draft.mentions.filter(isMentionSelector)
    : undefined;
  if (Array.isArray(draft.mentions) && mentions?.length !== draft.mentions.length) return "invalid";
  return {
    target,
    content: draft.content,
    idempotencyKey,
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
