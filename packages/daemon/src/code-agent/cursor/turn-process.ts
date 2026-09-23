import { getLogger } from "@logtape/logtape";
import {
  ProcessTreeOwner,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "#src/platform/process-tree";
import { AgentProcessCleanupError } from "#src/code-agent/contract";

const logger = getLogger(["coforge", "daemon", "code-agent", "cursor"]);

export type CursorTurnRecord = Readonly<Record<string, unknown>>;

export type CursorTurnResult = Readonly<{
  /** `null` when the process was killed by a signal rather than exiting on its own. */
  exitCode: number | null;
  /** A bounded tail of the turn's stderr output, for a failure whose reason has no `result`
   * frame to explain it. */
  stderrTail: string;
}>;

const STDERR_TAIL_BYTES = 4_096;

/**
 * One `cursor-agent` turn: a single child process spawned with the whole prompt as an argv item
 * and no stdin input, run to completion and disposed. Unlike `JsonlProcess`, whose persistent-CLI
 * contract treats every exit as an unexpected failure, a Cursor turn process is expected to exit
 * on its own once the turn ends - `exited` reports the real exit code so the session can tell a
 * clean turn from a crashed one. Reuses the same process-tree ownership and
 * `AgentProcessCleanupError` cleanup ladder every other code-agent process uses.
 */
export class CursorTurnProcess {
  readonly #tree: OwnedProcessTree;
  readonly #child: OwnedChildProcess;
  readonly #listeners = new Set<(record: CursorTurnRecord) => void>();
  readonly exited: Promise<CursorTurnResult>;
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
    logger.info("Started Cursor turn process", {
      event: "code_agent.process.started",
      pid: this.#child.pid,
      executable: command[0],
      argument_count: Math.max(command.length - 1, 0),
      outcome: "ok",
    });
    this.exited = this.#run();
  }

  onRecord(listener: (record: CursorTurnRecord) => void): () => void {
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

  async #run(): Promise<CursorTurnResult> {
    const [exitCode] = await Promise.all([
      this.#child.exited,
      this.#readStdout(),
      this.#readStderr(),
    ]);
    const result: CursorTurnResult = { exitCode, stderrTail: this.#stderrTail };
    logger.info("Cursor turn process exited", {
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
      // A per-turn process is not a persistent RPC peer; stray non-JSON stdout output (should
      // it ever occur) is not a protocol violation worth failing the turn over.
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const listener of this.#listeners) listener(value as CursorTurnRecord);
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.#child.stderr) {
      this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(
        -STDERR_TAIL_BYTES,
      );
    }
  }

  async #cleanupTree(): Promise<void> {
    try {
      await this.#tree.terminate(false);
    } catch {
      // A bounded tree check below determines whether cleanup was successful.
    }
    let treeExited: boolean;
    try {
      treeExited = await this.#tree.waitForExit(1_000);
    } catch {
      throw new AgentProcessCleanupError();
    }
    if (!treeExited) {
      try {
        await this.#tree.terminate(true);
      } catch {
        // A bounded tree check below determines whether cleanup was successful.
      }
      try {
        treeExited = await this.#tree.waitForExit(1_000);
      } catch {
        throw new AgentProcessCleanupError();
      }
    }
    if (!treeExited) throw new AgentProcessCleanupError();
    try {
      this.#child.stdin.end();
    } catch {
      // An exited child may have already closed stdin.
    }
    await this.exited;
  }
}
