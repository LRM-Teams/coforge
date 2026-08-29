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
    private readonly commandRunner: ProcessCommandRunner = runCommand,
  ) {}

  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree {
    if (this.platform === "win32") {
      throw new Error("Windows Agent process isolation is unavailable");
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
        if (this.platform === "win32") {
          await this.commandRunner([
            "taskkill",
            "/PID",
            String(pid),
            "/T",
            ...(force ? ["/F"] : []),
          ]);
          return;
        }
        try {
          globalThis.process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if ((error as { code?: string }).code !== "ESRCH") throw error;
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
      globalThis.process.kill(this.platform === "win32" ? pid : -pid, 0);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "ESRCH") return false;
      throw error;
    }
  }
}
