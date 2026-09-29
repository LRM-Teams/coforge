import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { normalizeSeenExactSeqs } from "@lrm/coforge-sdk/internal";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "consumed-seqs"]);

/** One Agent's consumed cursor for one target, after Raft's `targets[target]` record (1.0.32 bundle
 * 752736-752751): `seq` is the frontier the Agent has consumed (monotonic, never lower), `readOrder`
 * when the target was last reviewed, ordered against every other target's, and `reviewedSeq` the
 * newest message a review showed. `reviewedSeq` is CoForge's own addition: Raft folds it into `seq`,
 * but the two move apart here. A paged read reviews the target without moving the frontier a hold
 * is decided from; a sent send's advanced boundary moves the frontier without reviewing anything;
 * only a presented hold does both. */
export type AgentConsumedSeqEntry = Readonly<{
  seq?: number;
  readOrder?: number;
  reviewedSeq?: number;
  /** Raft 1.0.38's `exactSeqs`: messages above `seq` the Agent was shown one by one (a `check`, an
   * anchored `read`, a read the server did not call contiguous), ascending, at most
   * `SEEN_EXACT_SEQS_LIMIT`. A send reports them as `seenExactSeqs` so its freshness check does
   * not count them as unreviewed. */
  exactSeqs?: readonly number[];
}>;

/** Raft 1.0.38's `consumed-seqs.json` shape, plus `reviewedSeq`: a `targets` map, the `aliases` map,
 * and the next `readOrder` to hand out. `nextReadOrder` is never trusted as a starting point on
 * read — `read` recomputes it from the orders it actually sees, exactly as Raft's `normalizeState`
 * does. */
export type AgentConsumedSeqState = Readonly<{
  targets: Readonly<Record<string, AgentConsumedSeqEntry>>;
  /** Raft 1.0.38's `aliases`: another spelling of a target mapped to the spelling its cursor is
   * kept under, so both share one consumed state. Chains are compressed on read: every value is a
   * canonical target. */
  aliases: Readonly<Record<string, string>>;
  nextReadOrder: number;
}>;

/**
 * The port the attention index persists through. The index holds the Agent's consumed state in
 * memory once it has read it, so a store only reads a snapshot (normalizing a file nobody in this
 * process wrote) and writes one: one write per operation, however many targets, frontiers, exact
 * sequences, aliases and read orders that operation touched.
 */
export type AgentConsumedSeqPort = Readonly<{
  /** Raft's `readState`: never throws, and a missing or unreadable file is an empty state. */
  read(agentId: string): AgentConsumedSeqState;
  /** Replaces the Agent's durable state with this snapshot, best-effort like Raft's `writeState`. */
  write(agentId: string, state: AgentConsumedSeqState): void;
}>;

/** A number that can be a sequence or a read order: positive and finite, or nothing. */
function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The daemon's durable copy of the consumed cursor, in Raft 1.0.38's file shape plus one field
 * (`{ targets: { <target>: { seq, readOrder, reviewedSeq, exactSeqs } }, aliases, nextReadOrder }`).
 *
 * Why it has to be durable: the cursor decides whether a send is held (`modelSeenSequence`), which
 * frontier and exact sequences travel with a send, and whether a top-level send under a parent
 * whose newest read context is a thread needs confirming (and which threads a review showed
 * anything in). Raft keeps all of it in one file that outlives the process (`consumed-seqs.json`,
 * 1.0.32 bundle 752725-752800); the daemon used to keep it only in memory, so a restart silently
 * reset the Agent's read context to "never read anything".
 *
 * Raft reads, modifies and writes the file per record, because each CLI process is its own writer.
 * Here the daemon is the file's only writer and keeps the state in memory once read, so it writes a
 * whole snapshot per operation instead, still synchronously and still with write errors swallowed:
 * a lost write costs one cursor position, not a failed send. The file name and every field but
 * `reviewedSeq` are Raft's; the location is CoForge's own state directory.
 */
export class AgentConsumedSeqStore implements AgentConsumedSeqPort {
  readonly #root: string;

  /** Raft's `SLOCK_CLI_CONSUMED_SEQ_STATE_DIR ?? os.tmpdir()`, under CoForge's own directory name,
   * next to the draft store: this file belongs to the CLI's temporary state, not to the daemon's
   * persistent state directory (task #58, Frank: "放 /tmp"). */
  constructor(rootDirectory = process.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR ?? tmpdir()) {
    if (!rootDirectory) throw new Error("consumed-sequence state directory is required");
    this.#root = rootDirectory;
  }

  #path(agentId: string): string {
    if (!isSafePathScope(agentId)) throw new Error("invalid consumed-sequence Agent scope");
    return join(
      this.#root,
      `coforge-cli-consumed-seq-${encodeIdentity(String(process.geteuid?.() ?? userInfo().username))}`,
      encodeIdentity(agentId),
      "consumed-seqs.json",
    );
  }

  /** `/tmp` is world-writable, so the directories are ours before a cursor is written into them:
   * real directories (not symlinks) owned by this user, mode `0700`, as the draft store requires. */
  #prepareDirectories(path: string): void {
    for (const directory of [dirname(dirname(path)), dirname(path)]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const status = lstatSync(directory);
      if (status.isSymbolicLink() || !status.isDirectory())
        throw new Error("consumed-sequence directory must be a real directory");
      const uid = process.geteuid?.();
      if (uid !== undefined && status.uid !== uid)
        throw new Error("consumed-sequence directory must be owned by the current user");
      chmodSync(directory, 0o700);
    }
  }

  read(agentId: string): AgentConsumedSeqState {
    // The scope check happens before the read is guarded: an id that could not be a path segment is
    // a caller error, and swallowing it would answer "empty cursor" to a typo.
    const path = this.#path(agentId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Missing file, or one that a crash left half-written: Raft's `readState` starts over from an
      // empty state rather than failing the read that needs the cursor.
      return { targets: {}, aliases: {}, nextReadOrder: 1 };
    }
    return normalizeState(parsed);
  }

  /** Best-effort, like Raft's `writeState` inside `try { … } catch {}`: a cursor that cannot be
   * written costs the next cold start a stale boundary, and nothing else. */
  write(agentId: string, state: AgentConsumedSeqState): void {
    const path = this.#path(agentId);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      this.#prepareDirectories(path);
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch (error) {
      // Cleanup is best-effort too: when the directory itself could not be created, removing the
      // temporary path fails for the same reason, and that must not turn a lost cursor into a
      // failed send.
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Nothing left to clean up.
      }
      logger.warn("could not persist the consumed sequence cursor", {
        event: "message.consumed_seqs_write_failed",
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** This store's identity escaping; an empty identity is its own error. */
function encodeIdentity(identity: string): string {
  if (!identity) throw new Error("consumed-sequence identity is required");
  return escapePathIdentity(identity);
}

/**
 * Raft's `normalizeState` (1.0.38 `normalizeState`): keep the entries that carry an order, a
 * sequence or exact sequences above that sequence, compress alias chains, and start from a `nextReadOrder` that is above every order in the file — so a cursor
 * written by an older build (or hand-edited) can never hand out an order it already used. A
 * `reviewedSeq` is kept only beside a `readOrder`, since it describes a review. A file written
 * before `reviewedSeq` existed has none, so no thread counts as read context until it is read again.
 */
function normalizeState(value: unknown): AgentConsumedSeqState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { targets: {}, aliases: {}, nextReadOrder: 1 };
  const raw = value as { targets?: unknown; aliases?: unknown; nextReadOrder?: unknown };
  const targets: Record<string, AgentConsumedSeqEntry> = {};
  let maxObservedOrder = 0;
  if (raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets)) {
    for (const [target, entry] of Object.entries(raw.targets as Record<string, unknown>)) {
      if (target.length === 0 || !entry || typeof entry !== "object" || Array.isArray(entry))
        continue;
      const record = entry as {
        seq?: unknown;
        readOrder?: unknown;
        reviewedSeq?: unknown;
        exactSeqs?: unknown;
      };
      const seq = positiveFiniteNumber(record.seq);
      const readOrder = positiveFiniteNumber(record.readOrder);
      const exactSeqs = normalizeSeenExactSeqs(record.exactSeqs, seq ?? 0);
      if (seq === undefined && readOrder === undefined && exactSeqs.length === 0) continue;
      // A shown message without a review order is not a review; drop it with the order.
      const reviewedSeq =
        readOrder === undefined ? undefined : positiveFiniteNumber(record.reviewedSeq);
      targets[target] = {
        ...(seq !== undefined ? { seq } : {}),
        ...(readOrder !== undefined ? { readOrder } : {}),
        ...(reviewedSeq !== undefined ? { reviewedSeq } : {}),
        ...(exactSeqs.length > 0 ? { exactSeqs } : {}),
      };
      // Only a real order counts. Raft falls back to `seq` for files written before `readOrder`
      // existed; this file never had that shape, and a frontier recorded without a review must not
      // push the order counter up to its sequence.
      maxObservedOrder = Math.max(maxObservedOrder, readOrder ?? 0);
    }
  }
  const links = new Map<string, string>();
  if (raw.aliases && typeof raw.aliases === "object" && !Array.isArray(raw.aliases))
    for (const [spelling, canonical] of Object.entries(raw.aliases as Record<string, unknown>))
      if (spelling.length > 0 && typeof canonical === "string" && canonical.length > 0)
        if (spelling !== canonical) links.set(spelling, canonical);
  // Raft's `canonicalTargetKey` walks a chain on every lookup; the chain is walked once here, so each
  // spelling maps straight to its canonical target. A cycle names no canonical target and is dropped.
  const aliases: Record<string, string> = {};
  for (const spelling of links.keys()) {
    let canonical = spelling;
    const visited = new Set<string>([spelling]);
    for (let next = links.get(canonical); next !== undefined; next = links.get(canonical)) {
      if (visited.has(next)) {
        canonical = spelling;
        break;
      }
      visited.add(next);
      canonical = next;
    }
    if (canonical !== spelling) aliases[spelling] = canonical;
  }
  const rawNextReadOrder = positiveFiniteNumber(raw.nextReadOrder);
  return {
    targets,
    aliases,
    nextReadOrder: Math.max(rawNextReadOrder ?? 1, maxObservedOrder + 1),
  };
}
