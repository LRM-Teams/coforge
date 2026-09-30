import { describe, expect, test } from "bun:test";

import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { TurnProcess, type TurnInput } from "#src/code-agent/per-turn/turn-process";
import type {
  OwnedChildProcess,
  OwnedProcessTree,
  ProcessTreeSpawner,
} from "#src/platform/process-tree";

/** Records what the turn does to the child's stdin, in order, so a test can assert how the input
 * reaches it. */
class RecordingSpawner implements ProcessTreeSpawner {
  readonly stdin: string[] = [];
  readonly exited: Promise<number>;
  #release: (exitCode: number) => void = () => {};

  constructor() {
    this.exited = new Promise<number>((resolve) => {
      this.#release = resolve;
    });
  }

  finish(exitCode = 0): void {
    this.#release(exitCode);
  }

  spawn(): OwnedProcessTree {
    const stdin = this.stdin;
    const empty = async function* (): AsyncGenerator<Uint8Array> {};
    const child: OwnedChildProcess = {
      pid: 424242,
      exited: this.exited,
      get exitCode() {
        return null;
      },
      stdin: {
        write: (value) => {
          stdin.push(`write:${value}`);
          return true;
        },
        end: () => {
          stdin.push("end");
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

/** Starts a turn with `input`, lets it finish, and returns what it did to stdin. */
async function stdinOperations(input: TurnInput): Promise<string[]> {
  const spawner = new RecordingSpawner();
  const turn = new TurnProcess(
    {
      provider: RUNTIME_PROVIDER.GROK,
      displayName: "Grok",
      argv: ["grok", "-p", "hello"],
      cwd: "/tmp",
      environment: {},
      input,
    },
    spawner,
  );
  // Read straight after construction: the input is fed while the process is being spawned, never
  // later, so a CLI can never be left holding an open pipe by a slow session.
  const operations = [...spawner.stdin];
  spawner.finish(0);
  await turn.exited;
  return operations;
}

describe("TurnProcess input", () => {
  test("eof closes stdin immediately after spawn so the turn can never sit on an open pipe", async () => {
    // The OpenCode turn hung exactly this way (#652): a daemon-spawned child keeps the stdin pipe
    // open, and a CLI that waits for EOF never starts. A prompt that rides argv needs no stdin,
    // so it is closed at construction and never written.
    expect(await stdinOperations({ kind: "eof" })).toEqual(["end"]);
  });

  test("line writes the prompt as one line and then closes stdin", async () => {
    expect(await stdinOperations({ kind: "line", text: '{"event":"user"}' })).toEqual([
      'write:{"event":"user"}\n',
      "end",
    ]);
  });

  test("open never touches stdin", async () => {
    expect(await stdinOperations({ kind: "open" })).toEqual([]);
  });

  test("a child that closed stdin before it was fed does not fail the turn", async () => {
    const spawner = new RecordingSpawner();
    const spawn = spawner.spawn.bind(spawner);
    spawner.spawn = () => {
      const tree = spawn();
      tree.child.stdin.write = () => {
        throw new Error("stdin is closed");
      };
      return tree;
    };
    const turn = new TurnProcess(
      {
        provider: RUNTIME_PROVIDER.ANTIGRAVITY,
        displayName: "Antigravity",
        argv: ["agy"],
        cwd: "/tmp",
        environment: {},
        input: { kind: "line", text: "hello" },
      },
      spawner,
    );
    spawner.finish(1);
    expect((await turn.exited).exitCode).toBe(1);
  });
});
