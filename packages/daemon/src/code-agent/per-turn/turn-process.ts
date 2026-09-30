import { getLogger, type Logger } from "@logtape/logtape";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import {
  ProcessTreeOwner,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "#src/platform/process-tree";
import { cleanupOwnedTree } from "#src/code-agent/process-tree-cleanup";
import { readStderrTail } from "#src/code-agent/stderr-tail";

export type TurnRecord = Readonly<Record<string, unknown>>;

export type TurnResult = Readonly<{
  /** `null` when the process was killed by a signal rather than exiting on its own. */
  exitCode: number | null;
  /** A bounded tail of the turn's stderr output, for a failure whose reason no record explains. */
  stderrTail: string;
}>;

/**
 * How a turn's input reaches its child process:
 * - `open`: the prompt rides argv and stdin is left alone, so the pipe stays open until the
 *   process ends.
 * - `eof`: the prompt rides argv and stdin is closed right after spawn, so an inherited pipe can
 *   never hold the turn open. A CLI that waits for stdin EOF before it starts (`opencode run`,
 *   #652) needs this.
 * - `line`: the prompt is one line of stdin and stdin is closed straight after it, so the CLI runs
 *   exactly one turn and the prompt never appears in argv or a process listing.
 */
export type TurnInput =
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "eof" }>
  | Readonly<{ kind: "line"; text: string }>;

export type TurnLaunch = Readonly<{
  /** The provider whose turn this is; it is also the log category. */
  provider: RuntimeProvider;
  /** How the provider is named in the process log lines. */
  displayName: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  input: TurnInput;
}>;

/**
 * One turn of a per-turn code agent: a single child process, run to completion and disposed. Unlike
 * `JsonlProcess`, whose persistent-CLI contract treats every exit as an unexpected failure, a turn
 * process is expected to exit on its own once the turn ends - `exited` reports the real exit code
 * so the session can tell a clean turn from a crashed one. Stdout is one JSON object per line;
 * anything else is not worth failing a turn over. Reuses the same process-tree ownership and
 * `AgentProcessCleanupError` cleanup ladder every other code-agent process uses.
 */
export class TurnProcess {
  readonly #tree: OwnedProcessTree;
  readonly #child: OwnedChildProcess;
  readonly #listeners = new Set<(record: TurnRecord) => void>();
  readonly #logger: Logger;
  readonly #displayName: string;
  readonly exited: Promise<TurnResult>;
  #cleanupPromise: Promise<void> | undefined;

  constructor(launch: TurnLaunch, processTreeOwner: ProcessTreeSpawner = new ProcessTreeOwner()) {
    this.#logger = getLogger(["coforge", "daemon", "code-agent", launch.provider]);
    this.#displayName = launch.displayName;
    this.#tree = processTreeOwner.spawn(launch.argv, launch.cwd, launch.environment);
    this.#child = this.#tree.child;
    this.#feedInput(launch.input);
    this.#logger.info(`Started ${launch.displayName} turn process`, {
      event: "code_agent.process.started",
      pid: this.#child.pid,
      executable: launch.argv[0],
      argument_count: Math.max(launch.argv.length - 1, 0),
      outcome: "ok",
    });
    this.exited = this.#run();
  }

  onRecord(listener: (record: TurnRecord) => void): () => void {
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

  #feedInput(input: TurnInput): void {
    if (input.kind === "open") return;
    try {
      if (input.kind === "line") this.#child.stdin.write(`${input.text}\n`);
      this.#child.stdin.end();
    } catch {
      // A child that exited between spawn and this write may have already closed stdin; its exit
      // code and stderr report why.
    }
  }

  async #run(): Promise<TurnResult> {
    const [exitCode, , stderrTail] = await Promise.all([
      this.#child.exited,
      this.#readStdout(),
      readStderrTail(this.#child.stderr),
    ]);
    this.#logger.info(`${this.#displayName} turn process exited`, {
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
      // A per-turn process is not a persistent RPC peer: a stray non-JSON line (a shell wrapper's
      // banner, a CLI's own log) is not a protocol violation worth failing the turn over.
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const listener of this.#listeners) listener(value as TurnRecord);
  }

  async #cleanupTree(): Promise<void> {
    await cleanupOwnedTree(this.#tree, this.#child);
    await this.exited;
  }
}
