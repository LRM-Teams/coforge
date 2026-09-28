import { getLogger } from "@logtape/logtape";
import {
  ProcessTreeOwner,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "#src/platform/process-tree";
import { cleanupOwnedTree } from "#src/code-agent/process-tree-cleanup";
import { readStderrTail } from "#src/code-agent/stderr-tail";

const logger = getLogger(["coforge", "daemon", "code-agent", "grok"]);

export type GrokTurnRecord = Readonly<Record<string, unknown>>;

export type GrokTurnResult = Readonly<{
  /** `null` when the process was killed by a signal rather than exiting on its own. */
  exitCode: number | null;
  /** A bounded tail of the turn's stderr output, for a failure whose reason has no event to
   * explain it. */
  stderrTail: string;
}>;

/**
 * One `grok -p <prompt> --output-format streaming-json` turn: a single child process with the
 * prompt as an argv item, run to completion and disposed. The exit is the end of the turn — the
 * same per-turn shape as OpenCode's (ADR 0058) and Cursor's wrappers, and unlike `JsonlProcess`,
 * whose persistent-CLI contract treats every exit as an unexpected failure. Reuses the same
 * process-tree ownership and `AgentProcessCleanupError` ladder as every other code-agent process.
 */
export class GrokTurnProcess {
  readonly #tree: OwnedProcessTree;
  readonly #child: OwnedChildProcess;
  readonly #listeners = new Set<(record: GrokTurnRecord) => void>();
  readonly exited: Promise<GrokTurnResult>;
  #stderrTail = "";
  #cleanupPromise: Promise<void> | undefined;

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    processTreeOwner: ProcessTreeSpawner = new ProcessTreeOwner(),
  ) {
    this.#tree = processTreeOwner.spawn(command, cwd, environment);
    this.#child = this.#tree.child;
    // The turn reads its prompt from argv and never writes stdin. Close it immediately after
    // spawn so an inherited pipe can never hold the turn open — the OpenCode turn sat on an open
    // stdin pipe until dispose (#652); closing is unconditionally safe for a one-shot turn.
    try {
      this.#child.stdin.end();
    } catch {
      // A child that exited between spawn and this end may have already closed stdin.
    }
    logger.info("Started Grok turn process", {
      event: "code_agent.process.started",
      pid: this.#child.pid,
      executable: command[0],
      argument_count: Math.max(command.length - 1, 0),
      outcome: "ok",
    });
    this.exited = this.#run();
  }

  onRecord(listener: (record: GrokTurnRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  interrupt(): void {
    this.#child.kill("SIGINT");
  }

  /** Cleans up the process tree, same ladder and `AgentProcessCleanupError` semantics as
   * `JsonlProcess`. Safe to call after the process has already exited on its own. */
  async dispose(): Promise<void> {
    this.#cleanupPromise ??= this.#cleanupTree();
    return this.#cleanupPromise;
  }

  async #run(): Promise<GrokTurnResult> {
    const [exitCode] = await Promise.all([
      this.#child.exited,
      this.#readStdout(),
      this.#readStderr(),
    ]);
    const result: GrokTurnResult = { exitCode, stderrTail: this.#stderrTail };
    logger.info("Grok turn process exited", {
      event: "code_agent.process.exited",
      pid: this.#child.pid,
      exit_code: exitCode,
      outcome: exitCode === 0 ? "ok" : "error",
    });
    return result;
  }

  async #readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.#child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) this.#accept(line);
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.replace(/\r$/, "");
    if (tail) this.#accept(tail);
  }

  #accept(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // `streaming-json` is one JSON object per line; a stray non-JSON line (grok's own logs go
      // elsewhere, but a future build could change that) is not worth failing a turn for.
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const listener of this.#listeners) listener(value as GrokTurnRecord);
  }

  async #readStderr(): Promise<void> {
    this.#stderrTail = await readStderrTail(this.#child.stderr);
  }

  async #cleanupTree(): Promise<void> {
    await cleanupOwnedTree(this.#tree, this.#child);
    await this.exited;
  }
}
