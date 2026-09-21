import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "consumed-seqs"]);

/** The same scope guard the reminder receipts use: an Agent id is a path segment, so it is matched
 * against the id grammar before it can become one. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** One Agent's consumed cursor for one target — Raft's `targets[target]` record verbatim (1.0.32
 * bundle 752736-752751): `seq` is the frontier the Agent has consumed (monotonic, never lower),
 * `readOrder` is when that target was last reviewed, ordered against every other target's. */
export type AgentConsumedSeqEntry = Readonly<{ seq?: number; readOrder?: number }>;

/** Raft's `consumed-seqs.json` shape verbatim: a `targets` map plus the next `readOrder` to hand
 * out. `nextReadOrder` is never trusted as a starting point on read — `read` recomputes it from the
 * orders it actually sees, exactly as Raft's `normalizeState` does. */
export type AgentConsumedSeqState = Readonly<{
  targets: Readonly<Record<string, AgentConsumedSeqEntry>>;
  nextReadOrder: number;
}>;

/**
 * The port the attention index persists through. Raft's own function names, because they are also
 * the two mechanisms that matter: `recordConsumedSeqs` (a consumed frontier — a held notice's
 * `seenUpToSeq`) and `recordConsumedRead` (a review of a target, which is what orders targets
 * against each other).
 */
export type AgentConsumedSeqPort = Readonly<{
  /** Raft's `readState`: never throws, and a missing or unreadable file is an empty state. */
  read(agentId: string): AgentConsumedSeqState;
  /** Raft's `recordConsumedSeqs(agentId, entries)`; answers the highest `readOrder` it handed out
   * (`undefined` when nothing changed), which is how the caller keeps its in-memory orders in
   * lockstep with the file's. Raft's own function returns nothing — its state has one home. */
  recordConsumedSeqs(
    agentId: string,
    entries: Readonly<Record<string, number>>,
  ): number | undefined;
  /** Raft's `recordConsumedRead(agentId, target, sequence)`; answers the `readOrder` it assigned. */
  recordConsumedRead(agentId: string, target: string, sequence?: number): number | undefined;
}>;

/** A number that can be a sequence or a read order: positive and finite, or nothing. */
function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The daemon's durable copy of the consumed cursor, in Raft's file shape
 * (`{ targets: { <target>: { seq, readOrder } }, nextReadOrder }`).
 *
 * Why it has to be durable: the cursor decides whether a send is held (`modelSeenSequence`), which
 * frontier travels as `seenUpToSeq`, and whether a top-level send under a parent whose newest read
 * context is a thread needs confirming. Raft keeps all three in one file that outlives the process
 * (`consumed-seqs.json`, 1.0.32 bundle 752725-752800); the daemon used to keep them only in memory,
 * so a restart silently reset the Agent's read context to "never read anything".
 *
 * Raft's mechanism is a synchronous read-modify-write per record, with write errors swallowed —
 * best-effort persistence that can never fail a message send. Kept as it is: synchronous critical
 * sections cannot interleave (no lost update between two records racing for the same Agent), and a
 * lost write costs one cursor position, not a failed send. The file name and every field are
 * Raft's; only the location is CoForge's own state directory.
 */
export class AgentConsumedSeqStore implements AgentConsumedSeqPort {
  constructor(
    private readonly stateDirectory: string,
    private readonly workspaceId: string,
  ) {
    if (!stateDirectory || !SAFE.test(workspaceId))
      throw new Error("invalid consumed-sequence state scope");
  }

  #path(agentId: string): string {
    if (!SAFE.test(agentId)) throw new Error("invalid consumed-sequence Agent scope");
    return join(
      this.stateDirectory,
      "agent-consumed-seqs",
      this.workspaceId,
      agentId,
      "consumed-seqs.json",
    );
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

  recordConsumedSeqs(
    agentId: string,
    entries: Readonly<Record<string, number>>,
  ): number | undefined {
    const updates = Object.entries(entries).filter(
      ([target, sequence]) => target.length > 0 && positiveFiniteNumber(sequence) !== undefined,
    );
    if (updates.length === 0) return undefined;
    const state = mutableState(this.read(agentId));
    let changed = false;
    for (const [target, sequence] of updates) {
      const prior = state.targets[target] ?? {};
      state.targets[target] = {
        seq:
          positiveFiniteNumber(prior.seq) === undefined || sequence > prior.seq!
            ? sequence
            : prior.seq,
        readOrder: state.nextReadOrder,
      };
      state.nextReadOrder += 1;
      if (
        state.targets[target].seq !== prior.seq ||
        state.targets[target].readOrder !== prior.readOrder
      )
        changed = true;
    }
    // Raft only pays for the write when a cursor actually moved.
    if (!changed) return undefined;
    this.#write(agentId, state);
    return state.nextReadOrder - 1;
  }

  recordConsumedRead(agentId: string, target: string, sequence?: number): number | undefined {
    if (target.length === 0) return undefined;
    const state = mutableState(this.read(agentId));
    const prior = state.targets[target] ?? {};
    const nextSeq = positiveFiniteNumber(sequence);
    state.targets[target] = {
      seq:
        nextSeq !== undefined &&
        (positiveFiniteNumber(prior.seq) === undefined || nextSeq > prior.seq!)
          ? nextSeq
          : prior.seq,
      readOrder: state.nextReadOrder,
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
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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

type MutableState = { targets: Record<string, AgentConsumedSeqEntry>; nextReadOrder: number };

function mutableState(state: AgentConsumedSeqState): MutableState {
  return { targets: { ...state.targets }, nextReadOrder: state.nextReadOrder };
}

/**
 * Raft's `normalizeState` (1.0.32 bundle 752730-752752): keep the entries that carry an order or a
 * sequence, and start from a `nextReadOrder` that is above every order in the file — so a cursor
 * written by an older build (or hand-edited) can never hand out an order it already used.
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
      const record = entry as { seq?: unknown; readOrder?: unknown };
      const seq = positiveFiniteNumber(record.seq);
      const readOrder = positiveFiniteNumber(record.readOrder);
      if (seq === undefined && readOrder === undefined) continue;
      targets[target] = { seq, readOrder };
      maxObservedOrder = Math.max(maxObservedOrder, readOrder ?? seq ?? 0);
    }
  }
  const rawNextReadOrder = positiveFiniteNumber(raw.nextReadOrder);
  return { targets, nextReadOrder: Math.max(rawNextReadOrder ?? 1, maxObservedOrder + 1) };
}
