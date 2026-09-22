import { LocalDaemonLauncher, type LocalDaemonLauncherOptions } from "./launcher";
import type { DaemonLauncher, DaemonWorkspaceConfig } from "./launcher";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";

type CommandRunner = (command: string[]) => Promise<number>;

export class WindowsUserDaemonHost implements DaemonLauncher {
  readonly #taskName: string;
  readonly #run: CommandRunner;
  readonly #local: LocalDaemonLauncher;
  readonly #command: string;

  constructor(options: {
    taskName?: string;
    executablePath: string;
    socketPath: string;
    stateDirectory?: string;
    serverUrl?: string;
    daemonConnectionEndpoint?: string;
    run?: CommandRunner;
    connect?: LocalDaemonLauncherOptions["connect"];
    timeoutMilliseconds?: number;
  }) {
    this.#taskName = options.taskName ?? "CoForge Daemon";
    this.#run = options.run ?? runCommand;
    const daemonCommand = `"${options.executablePath.replaceAll('"', '""')}" __daemon --socket "${options.socketPath.replaceAll('"', '""')}"${options.stateDirectory ? ` --state-directory "${options.stateDirectory.replaceAll('"', '""')}"` : ""}`;
    this.#command = options.daemonConnectionEndpoint
      ? `cmd.exe /d /s /c "set COFORGE_DAEMON_CONNECTION_ENDPOINT=${options.daemonConnectionEndpoint}&& ${daemonCommand}"`
      : daemonCommand;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory ?? join(homedir(), ".coforge", "daemon"),
      serverUrl: options.serverUrl,
      connect: options.connect,
      timeoutMilliseconds: options.timeoutMilliseconds,
    });
  }

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<void> {
    // Prefer the user logon task when registration is allowed. When Create/Run is refused
    // (common without elevation), fall back to an already-running foreground supervisor —
    // never detach an unmanaged process.
    const created = await this.#run([
      "schtasks.exe",
      "/Create",
      "/TN",
      this.#taskName,
      "/SC",
      "ONLOGON",
      "/TR",
      this.#command,
      "/F",
    ]);
    if (created === 0) {
      const started = await this.#run(["schtasks.exe", "/Run", "/TN", this.#taskName]);
      if (started === 0) {
        await this.#local.ensureStarted(config);
        return;
      }
    }
    try {
      await this.#local.ensureStarted(config);
    } catch (error) {
      throw new Error(
        "The Windows user task could not start CoForge Daemon. Run `coforge-computer foreground` under an external supervisor; CoForge will not detach a fallback process.",
        { cause: error },
      );
    }
  }

  async ensureRunning(): Promise<void> {
    const result = await this.#run(["schtasks.exe", "/Run", "/TN", this.#taskName]);
    if (result !== 0)
      throw new Error(
        "The Windows user task could not start CoForge Daemon. Run `coforge-computer foreground` under an external supervisor; CoForge will not detach a fallback process.",
      );
    await this.#local.ensureRunning();
  }

  command(
    operation: "start" | "stop" | "restart",
    workspaceId?: string,
  ): Promise<ManagedRuntimeIdentity[]> {
    return this.#local.command(operation, workspaceId);
  }

  async stop(): Promise<void> {
    const result = await this.#run(["schtasks.exe", "/End", "/TN", this.#taskName]);
    if (result !== 0) throw new Error("could not stop the CoForge Daemon user task");
  }

  /** The in-place replacement `coforge-computer restart --supervisor` uses to restart the
   * Coordinator process itself. `/End`'s exit code is ignored - the task may already be
   * stopped, which is not a restart failure - and `/Run` is the actual restart. */
  async restart(): Promise<void> {
    await this.#run(["schtasks.exe", "/End", "/TN", this.#taskName]);
    const result = await this.#run(["schtasks.exe", "/Run", "/TN", this.#taskName]);
    if (result !== 0) throw new Error("could not restart the CoForge Daemon user task");
    await this.#local.ensureRunning();
  }
}

async function runCommand(command: string[]): Promise<number> {
  const process = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await process.exited;
}
