import { getLogger } from "@logtape/logtape";
import {
  ProcessTreeOwner,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "../../platform/process-tree";
import { AgentProcessCleanupError } from "../contract";

const logger = getLogger(["coforge", "daemon", "code-agent", "opencode"]);

export type OpenCodeTurnRecord = Readonly<Record<string, unknown>>;

export type OpenCodeTurnResult = Readonly<{
  /** `null` when the process was killed by a signal rather than exiting on its own. */
  exitCode: number | null;
  /** A bounded tail of the turn's stderr output, for a failure whose reason has no event to
   * explain it. */
  stderrTail: string;
}>;

const STDERR_TAIL_BYTES = 4_096;

/**
 * One `opencode run --format json` turn: a single child process with the prompt as its last argv
 * item, run to completion and disposed. Like Cursor's turn process (and unlike `JsonlProcess`,
 * whose persistent-CLI contract treats every exit as an unexpected failure) the exit *is* the end
 * of the turn, so `exited` reports the real exit code and the session decides what it means.
 * Reuses the same process-tree ownership and `AgentProcessCleanupError` ladder as every other
 * code-agent process.
 */
export class OpenCodeTurnProcess {
  readonly #tree: OwnedProcessTree;
  readonly #child: OwnedChildProcess;
  readonly #listeners = new Set<(record: OpenCodeTurnRecord) => void>();
  readonly exited: Promise<OpenCodeTurnResult>;
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
    // `opencode run` takes its prompt from argv and then waits for stdin EOF before it starts
    // working — with the daemon's `stdin: "pipe"` and nothing ever written, the turn sat on an
    // open pipe until dispose and the Agent looked permanently offline (verified: `< /dev/null`
    // completes in ~3s, an open pipe never produces output). The turn never writes stdin, so
    // close it immediately after spawn.
    try {
      this.#child.stdin.end();
    } catch {
      // A child that exited between spawn and this end may have already closed stdin.
    }
    logger.info("Started OpenCode turn process", {
      event: "code_agent.process.started",
      pid: this.#child.pid,
      executable: command[0],
      argument_count: Math.max(command.length - 1, 0),
      outcome: "ok",
    });
    this.exited = this.#run();
  }

  onRecord(listener: (record: OpenCodeTurnRecord) => void): () => void {
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

  async #run(): Promise<OpenCodeTurnResult> {
    const [exitCode] = await Promise.all([
      this.#child.exited,
      this.#readStdout(),
      this.#readStderr(),
    ]);
    const result: OpenCodeTurnResult = { exitCode, stderrTail: this.#stderrTail };
    logger.info("OpenCode turn process exited", {
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
      // `--format json` is one JSON object per line; a stray non-JSON line (opencode writes its
      // logs to stderr, but a future build could change that) is not worth failing a turn for.
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const listener of this.#listeners) listener(value as OpenCodeTurnRecord);
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
