import { describe, expect, test } from "bun:test";

import { OpenCodeTurnProcess } from "../src/code-agent/opencode/turn-process";
import type {
  OwnedChildProcess,
  OwnedProcessTree,
  ProcessTreeSpawner,
} from "../src/platform/process-tree";

/** Records `stdin.end()` calls so the test can assert EOF is signalled to the child. */
class RecordingSpawner implements ProcessTreeSpawner {
  endCalls = 0;
  #release: (exitCode: number) => void;

  constructor() {
    let release: (exitCode: number) => void = () => {};
    this.#release = (exitCode) => release(exitCode);
    this.exited = new Promise<number>((resolve) => {
      release = resolve;
    });
  }

  exited: Promise<number>;

  finish(exitCode = 0): void {
    this.endCalls += 0;
    this.#release(exitCode);
  }

  spawn(): OwnedProcessTree {
    const self = this;
    const empty = async function* (): AsyncGenerator<Uint8Array> {};
    const child: OwnedChildProcess = {
      pid: 424242,
      exited: self.exited,
      get exitCode() {
        return null;
      },
      stdin: {
        write: () => {
          throw new Error("the turn must never write stdin");
        },
        end: () => {
          self.endCalls += 1;
        },
        flush: async () => {},
      },
      stdout: empty(),
      stderr: empty(),
      kill: () => {},
    };
    return {
      child,
      terminate: async () => {},
      waitForExit: async () => true,
    };
  }
}

describe("OpenCodeTurnProcess", () => {
  test("closes stdin immediately after spawn so `opencode run` sees EOF and starts working", () => {
    const spawner = new RecordingSpawner();
    const turn = new OpenCodeTurnProcess(
      ["opencode", "run", "--format", "json", "--auto", "hello"],
      "/tmp",
      {},
      spawner,
    );
    // The child's stdin must be closed during construction — `opencode run` waits for stdin EOF
    // before doing anything, and the turn never writes stdin (the prompt is argv).
    expect(spawner.endCalls).toBe(1);
    spawner.finish(0);
    return turn.exited;
  });
});
