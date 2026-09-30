import { getLogger } from "@logtape/logtape";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  ProcessTreeOwner,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "#src/platform/process-tree";
import { cleanupOwnedTree } from "#src/code-agent/process-tree-cleanup";
import { readStderrTail } from "#src/code-agent/stderr-tail";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.ANTIGRAVITY]);

type AntigravityTurnRecord = Readonly<Record<string, unknown>>;

export type AntigravityTurnResult = Readonly<{
  /** `null` when the process was killed by a signal rather than exiting on its own. */
  exitCode: number | null;
  /** A bounded tail of the turn's stderr output. agy prints its `AGY_ERROR: {...}` line and
   * its sign-in and flag errors there, not on stdout. */
  stderrTail: string;
}>;

/**
 * One headless `agy` turn: a single child process that reads its prompt as one
 * `{"event":"user",...}` line from stdin (`--input-format stream-json`), prints `stream-json`
 * frames, and exits when the turn ends. stdin is closed straight after that one line, so agy runs
 * exactly one turn; the prompt never appears in argv or a process listing.
 */
export class AntigravityTurnProcess {
  readonly #tree: OwnedProcessTree;
  readonly #child: OwnedChildProcess;
  readonly #listeners = new Set<(record: AntigravityTurnRecord) => void>();
  readonly exited: Promise<AntigravityTurnResult>;
  /** The input this turn was spawned with. */
  readonly prompt: string;
  #cleanupPromise: Promise<void> | undefined;

  constructor(
    command: readonly string[],
    prompt: string,
    cwd: string,
    environment: Readonly<Record<string, string>>,
    processTreeOwner: ProcessTreeSpawner = new ProcessTreeOwner(),
  ) {
    this.prompt = prompt;
    this.#tree = processTreeOwner.spawn(command, cwd, environment);
    this.#child = this.#tree.child;
    try {
      this.#child.stdin.write(
        `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
      );
      this.#child.stdin.end();
    } catch {
      // A child that exited between spawn and this write already closed stdin; its exit code
      // and stderr report why.
    }
    logger.info("Started Antigravity turn process", {
      event: "code_agent.process.started",
      pid: this.#child.pid,
      executable: command[0],
      argument_count: Math.max(command.length - 1, 0),
      outcome: "ok",
    });
    this.exited = this.#run();
  }

  onRecord(listener: (record: AntigravityTurnRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  interrupt(): void {
    this.#child.kill("SIGINT");
  }

  /** Cleans up the process tree with the same ladder every code-agent process uses. Safe to call
   * after the process has already exited on its own. */
  async dispose(): Promise<void> {
    this.#cleanupPromise ??= this.#cleanupTree();
    return this.#cleanupPromise;
  }

  async #run(): Promise<AntigravityTurnResult> {
    const [exitCode, , stderrTail] = await Promise.all([
      this.#child.exited,
      this.#readStdout(),
      readStderrTail(this.#child.stderr),
    ]);
    logger.info("Antigravity turn process exited", {
      event: "code_agent.process.exited",
      pid: this.#child.pid,
      exit_code: exitCode,
      outcome: exitCode === 0 ? "ok" : "error",
    });
    return { exitCode, stderrTail };
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
      // A shell wrapper installed in front of agy may print its own banner on stdout; a line that
      // is not a frame is not worth failing the turn for.
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const listener of this.#listeners) listener(value as AntigravityTurnRecord);
  }

  async #cleanupTree(): Promise<void> {
    await cleanupOwnedTree(this.#tree, this.#child);
    await this.exited;
  }
}
