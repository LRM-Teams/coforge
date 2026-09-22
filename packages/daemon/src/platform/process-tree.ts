import { LaunchdProcessOwner } from "./launchd-process";
import {
  createWindowsJobObject,
  windowsJobObjectsAvailable,
  type WindowsJobObject,
  type WindowsJobObjectFactory,
} from "./windows-job-object";

type ProcessSignal = "SIGINT" | "SIGKILL" | "SIGTERM";

export interface OwnedChildProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stdin: { write(value: string): boolean; end(): void; flush(): Promise<void> };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  kill(signal?: ProcessSignal): void;
}

export interface OwnedProcessTree {
  readonly child: OwnedChildProcess;
  terminate(force: boolean): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export type ProcessCommandRunner = (command: readonly string[]) => Promise<void>;

export interface ProcessTreeSpawner {
  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree;
}

export type ProcessTreeOwnerOptions = {
  /** Test seam / production factory for Windows Job Objects. */
  createJobObject?: WindowsJobObjectFactory;
};

const runCommand: ProcessCommandRunner = async (command) => {
  const process = Bun.spawn({
    cmd: [...command],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited ${exitCode}`);
};

/** Owns the platform-specific process tree while exposing one lifecycle seam. */
export class ProcessTreeOwner implements ProcessTreeSpawner {
  constructor(
    private readonly platform = globalThis.process.platform,
    // Kept as a constructor seam for tests; Unix terminate uses process.kill, Windows uses Job Objects.
    _commandRunner: ProcessCommandRunner = runCommand,
    private readonly options: ProcessTreeOwnerOptions = {},
  ) {}

  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree {
    if (this.platform === "win32") return this.#spawnWindows(command, cwd, environment);
    if (this.platform === "darwin" && Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX) {
      const directory = Bun.env.COFORGE_WORKSPACE_JOB_DIRECTORY;
      if (!directory) throw new Error("Workspace Agent job directory is missing");
      return new LaunchdProcessOwner({
        directory,
        prefix: Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX,
        runner: [process.execPath, "__managed-agent"],
      }).spawn(command, cwd, environment);
    }
    const spawned = Bun.spawn({
      cmd: [...command],
      cwd,
      env: { ...environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      windowsHide: true,
    });
    const child: OwnedChildProcess = {
      get pid() {
        return spawned.pid;
      },
      exited: spawned.exited,
      get exitCode() {
        return spawned.exitCode;
      },
      stdin: {
        write: (value) => {
          spawned.stdin.write(value);
          return true;
        },
        end: () => spawned.stdin.end(),
        flush: async () => {
          await spawned.stdin.flush();
        },
      },
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      kill: (signal) => void spawned.kill(signal),
    };
    return {
      child,
      terminate: async (force) => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          globalThis.process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if (!this.#groupIsGone(error)) throw error;
        }
      },
      waitForExit: async (timeoutMs) => {
        const pid = child.pid;
        if (pid === undefined) return true;
        const deadline = Date.now() + timeoutMs;
        while (await this.#treeExists(pid)) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(20);
        }
        return true;
      },
    };
  }

  #spawnWindows(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree {
    const createJob = this.options.createJobObject ?? defaultWindowsJobFactory;
    let job: WindowsJobObject;
    try {
      job = createJob();
    } catch (error) {
      throw new Error("Windows Agent process isolation is unavailable", { cause: error });
    }

    const spawned = Bun.spawn({
      cmd: [...command],
      cwd,
      env: { ...environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const pid = spawned.pid;
    if (pid === undefined) {
      job.close();
      throw new Error("Windows Agent child did not report a PID");
    }
    try {
      job.assign(pid);
    } catch (error) {
      try {
        spawned.kill();
      } catch {
        // Best-effort: assignment failed, so the Job Object never owned the tree.
      }
      job.close();
      throw error;
    }

    const child: OwnedChildProcess = {
      get pid() {
        return spawned.pid;
      },
      exited: spawned.exited.finally(() => {
        // Keep the job handle until waitForExit/terminate can observe ActiveProcesses.
      }),
      get exitCode() {
        return spawned.exitCode;
      },
      stdin: {
        write: (value) => {
          spawned.stdin.write(value);
          return true;
        },
        end: () => spawned.stdin.end(),
        flush: async () => {
          await spawned.stdin.flush();
        },
      },
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      kill: (signal) => void spawned.kill(signal),
    };

    let closed = false;
    const closeJob = () => {
      if (closed) return;
      closed = true;
      job.close();
    };

    return {
      child,
      terminate: async () => {
        if (closed) return;
        try {
          job.terminate(1);
        } catch (error) {
          // Already-empty jobs may reject terminate; only rethrow when members remain.
          if (!closed && job.activeProcesses() !== 0) throw error;
        }
      },
      waitForExit: async (timeoutMs) => {
        if (closed) return true;
        const deadline = Date.now() + timeoutMs;
        while (!closed && job.activeProcesses() > 0) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(20);
        }
        closeJob();
        return true;
      },
    };
  }

  async #treeExists(pid: number): Promise<boolean> {
    if (this.platform === "linux") {
      for await (const entry of new Bun.Glob("[0-9]*").scan({
        cwd: "/proc",
        onlyFiles: false,
      })) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = await Bun.file(`/proc/${entry}/stat`).text();
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const state = fields[0];
          const processGroup = Number(fields[2]);
          if (processGroup === pid && state !== "Z") return true;
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      return false;
    }
    try {
      globalThis.process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (this.#groupIsGone(error)) return false;
      throw error;
    }
  }

  /** Whether a failed `kill` against the owned process group means nothing is left to signal.
   *
   * `ESRCH` says the group is gone. macOS answers `EPERM` instead while the group's only remaining
   * member is a zombie: the child has exited but its owner has not reaped it yet, and `kill`
   * refuses a group with nothing signalable left in it. A group that still holds a live process
   * answers 0, so `EPERM` means no live member - the same condition the linux branch states
   * explicitly as `state !== "Z"`. Every other failure is real and must propagate. */
  #groupIsGone(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    return code === "ESRCH" || (this.platform === "darwin" && code === "EPERM");
  }
}

function defaultWindowsJobFactory(): WindowsJobObject {
  if (!windowsJobObjectsAvailable()) {
    throw new Error("Windows Job Object APIs are unavailable");
  }
  return createWindowsJobObject();
}
