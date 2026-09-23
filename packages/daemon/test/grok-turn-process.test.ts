import { describe, expect, test } from "bun:test";

import { GrokTurnProcess } from "../src/code-agent/grok/turn-process";
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

describe("GrokTurnProcess", () => {
  test("closes stdin immediately after spawn so the turn can never sit on an open pipe", () => {
    // The OpenCode turn hung exactly this way (#652): a daemon-spawned child keeps the stdin pipe
    // open, a CLI that waits for EOF (or reads it) never starts. Grok's prompt rides argv, so the
    // turn must never write stdin and must close the pipe at construction.
    const spawner = new RecordingSpawner();
    const turn = new GrokTurnProcess(
      ["grok", "-p", "hello", "--output-format", "streaming-json", "--always-approve"],
      "/tmp",
      {},
      spawner,
    );
    expect(spawner.endCalls).toBe(1);
    spawner.finish(0);
    return turn.exited;
  });
});
