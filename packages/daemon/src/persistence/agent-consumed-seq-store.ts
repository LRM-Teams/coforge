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
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "consumed-seqs"]);

/** One Agent's consumed cursor for one target, after Raft's `targets[target]` record (1.0.32 bundle
 * 752736-752751): `seq` is the frontier the Agent has consumed (monotonic, never lower), `readOrder`
 * when the target was last reviewed, ordered against every other target's, and `reviewedSeq` the
 * newest message a review showed. `reviewedSeq` is CoForge's own addition: Raft folds it into `seq`,
 * but a paged read must not move the frontier a hold is decided from, and a `check` moves that
 * frontier without reviewing anything. */
export type AgentConsumedSeqEntry = Readonly<{
  seq?: number;
  readOrder?: number;
  reviewedSeq?: number;
}>;

/** Raft's `consumed-seqs.json` shape, plus `reviewedSeq`: a `targets` map plus the next `readOrder` to hand
 * out. `nextReadOrder` is never trusted as a starting point on read — `read` recomputes it from the
 * orders it actually sees, exactly as Raft's `normalizeState` does. */
export type AgentConsumedSeqState = Readonly<{
  targets: Readonly<Record<string, AgentConsumedSeqEntry>>;
  nextReadOrder: number;
}>;

/**
 * The port the attention index persists through, under Raft's function names for the two
 * mechanisms that matter: `recordConsumedSeqs` (a consumed frontier — what a check, a read or a held
 * notice showed the Agent) and `recordConsumedRead` (a review of a target, which is what orders
 * targets against each other).
 */
export type AgentConsumedSeqPort = Readonly<{
  /** Raft's `readState`: never throws, and a missing or unreadable file is an empty state. */
  read(agentId: string): AgentConsumedSeqState;
  /** Moves each target's consumed `seq` frontier and leaves its `readOrder` alone: consuming
   * messages is not reviewing a target. The daemon records `check` pages here, and a check must not
   * order anything; a held send takes its order separately through `recordConsumedRead`. (Raft's
   * `recordConsumedSeqs` takes an order, but Raft calls it only for a held send; Raft 1.0.32's
   * `check` records nothing.) */
  recordConsumedSeqs(agentId: string, entries: Readonly<Record<string, number>>): void;
  /** A review of `target`: takes the next `readOrder` and raises `reviewedSeq` to `sequence`, leaving
   * the consumed `seq` alone (Raft's `recordConsumedRead`, which raises `seq` instead). Answers the
   * `readOrder` it assigned. */
  recordConsumedRead(agentId: string, target: string, sequence?: number): number | undefined;
}>;

/** A number that can be a sequence or a read order: positive and finite, or nothing. */
function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The daemon's durable copy of the consumed cursor, in Raft's file shape plus one field
 * (`{ targets: { <target>: { seq, readOrder, reviewedSeq } }, nextReadOrder }`).
 *
 * Why it has to be durable: the cursor decides whether a send is held (`modelSeenSequence`), which
 * frontier travels as `seenUpToSeq`, and whether a top-level send under a parent whose newest read
 * context is a thread needs confirming (and which threads a review showed anything in). Raft keeps all three in one file that outlives the process
 * (`consumed-seqs.json`, 1.0.32 bundle 752725-752800); the daemon used to keep them only in memory,
 * so a restart silently reset the Agent's read context to "never read anything".
 *
 * Raft's mechanism is a synchronous read-modify-write per record, with write errors swallowed —
 * best-effort persistence that can never fail a message send. Kept as it is: synchronous critical
 * sections cannot interleave (no lost update between two records racing for the same Agent), and a
 * lost write costs one cursor position, not a failed send. The file name and every field but
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
      return { targets: {}, nextReadOrder: 1 };
    }
    return normalizeState(parsed);
  }

  recordConsumedSeqs(agentId: string, entries: Readonly<Record<string, number>>): void {
    const updates = Object.entries(entries).filter(
      ([target, sequence]) => target.length > 0 && positiveFiniteNumber(sequence) !== undefined,
    );
    if (updates.length === 0) return;
    const state = mutableState(this.read(agentId));
    let changed = false;
    for (const [target, sequence] of updates) {
      const prior = state.targets[target] ?? {};
      if (positiveFiniteNumber(prior.seq) !== undefined && sequence <= prior.seq!) continue;
      state.targets[target] = { ...prior, seq: sequence };
      changed = true;
    }
    // Raft only pays for the write when a cursor actually moved.
    if (changed) this.#write(agentId, state);
  }

  recordConsumedRead(agentId: string, target: string, sequence?: number): number | undefined {
    if (target.length === 0) return undefined;
    const state = mutableState(this.read(agentId));
    const prior = state.targets[target] ?? {};
    const reviewed = positiveFiniteNumber(sequence);
    const priorReviewed = positiveFiniteNumber(prior.reviewedSeq);
    state.targets[target] = {
      ...prior,
      readOrder: state.nextReadOrder,
      reviewedSeq:
        reviewed !== undefined && (priorReviewed === undefined || reviewed > priorReviewed)
          ? reviewed
          : priorReviewed,
    };
    state.nextReadOrder += 1;
    this.#write(agentId, state);
    return state.targets[target].readOrder;
  }

  /** Best-effort, like Raft's `writeState` inside `try { … } catch {}`: a cursor that cannot be
   * written costs the next cold start a stale boundary, and nothing else. */
  #write(
    agentId: string,
    state: { targets: Record<string, AgentConsumedSeqEntry>; nextReadOrder: number },
  ): void {
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

type MutableState = { targets: Record<string, AgentConsumedSeqEntry>; nextReadOrder: number };

function mutableState(state: AgentConsumedSeqState): MutableState {
  return { targets: { ...state.targets }, nextReadOrder: state.nextReadOrder };
}

/**
 * Raft's `normalizeState` (1.0.32 bundle 752730-752752): keep the entries that carry an order or a
 * sequence, and start from a `nextReadOrder` that is above every order in the file — so a cursor
 * written by an older build (or hand-edited) can never hand out an order it already used. A
 * `reviewedSeq` is kept only beside a `readOrder`, since it describes a review. A file written
 * before `reviewedSeq` existed has none, so no thread counts as read context until it is read again.
 */
function normalizeState(value: unknown): AgentConsumedSeqState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { targets: {}, nextReadOrder: 1 };
  const raw = value as { targets?: unknown; nextReadOrder?: unknown };
  const targets: Record<string, AgentConsumedSeqEntry> = {};
  let maxObservedOrder = 0;
  if (raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets)) {
    for (const [target, entry] of Object.entries(raw.targets as Record<string, unknown>)) {
      if (target.length === 0 || !entry || typeof entry !== "object" || Array.isArray(entry))
        continue;
      const record = entry as { seq?: unknown; readOrder?: unknown; reviewedSeq?: unknown };
      const seq = positiveFiniteNumber(record.seq);
      const readOrder = positiveFiniteNumber(record.readOrder);
      if (seq === undefined && readOrder === undefined) continue;
      // A shown message without a review order is not a review; drop it with the order.
      const reviewedSeq =
        readOrder === undefined ? undefined : positiveFiniteNumber(record.reviewedSeq);
      targets[target] = { seq, readOrder, reviewedSeq };
      // Only a real order counts. Raft falls back to `seq` for files written before `readOrder`
      // existed; this file never had that shape, and a frontier recorded without a review
      // (`recordConsumedSeqs`) must not push the order counter up to its sequence.
      maxObservedOrder = Math.max(maxObservedOrder, readOrder ?? 0);
    }
  }
  const rawNextReadOrder = positiveFiniteNumber(raw.nextReadOrder);
  return { targets, nextReadOrder: Math.max(rawNextReadOrder ?? 1, maxObservedOrder + 1) };
}
