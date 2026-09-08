import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher, DaemonWorkspaceConfig } from "./launcher";
import { homedir } from "node:os";
import { join } from "node:path";

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
  }) {
    this.#taskName = options.taskName ?? "CoForge Daemon";
    this.#run = options.run ?? runCommand;
    const daemonCommand = `"${options.executablePath.replaceAll('"', '""')}" __daemon --socket ${options.socketPath}${options.stateDirectory ? ` --state-directory "${options.stateDirectory}"` : ""}`;
    this.#command = options.daemonConnectionEndpoint
      ? `cmd.exe /d /s /c "set COFORGE_DAEMON_CONNECTION_ENDPOINT=${options.daemonConnectionEndpoint}&& ${daemonCommand}"`
      : daemonCommand;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory ?? join(homedir(), ".coforge", "daemon"),
      serverUrl: options.serverUrl,
    });
  }

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<void> {
    const result = await this.#run([
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
    if (result !== 0) throw new Error("could not register the CoForge Daemon user task");
    await this.ensureRunning();
    await this.#local.ensureStarted(config);
  }

  async ensureRunning(): Promise<void> {
    const result = await this.#run(["schtasks.exe", "/Run", "/TN", this.#taskName]);
    if (result !== 0)
      throw new Error(
        "The Windows user task could not start CoForge Daemon. Run `coforge-computer foreground` under an external supervisor; CoForge will not detach a fallback process.",
      );
    await this.#local.ensureRunning();
  }

  command(operation: "start" | "stop" | "restart", workspaceId?: string): Promise<void> {
    return this.#local.command(operation, workspaceId);
  }

  async stop(): Promise<void> {
    const result = await this.#run(["schtasks.exe", "/End", "/TN", this.#taskName]);
    if (result !== 0) throw new Error("could not stop the CoForge Daemon user task");
  }
}

async function runCommand(command: string[]): Promise<number> {
  const process = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await process.exited;
}
