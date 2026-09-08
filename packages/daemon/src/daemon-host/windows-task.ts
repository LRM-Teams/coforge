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
    serverUrl: string;
    daemonConnectionEndpoint?: string;
    run?: CommandRunner;
  }) {
    this.#taskName = options.taskName ?? "CoForge Daemon";
    this.#run = options.run ?? runCommand;
    const daemonCommand = `"${options.executablePath.replaceAll('"', '""')}" --socket ${options.socketPath}${options.stateDirectory ? ` --state-directory "${options.stateDirectory}"` : ""}`;
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
    const start = await this.#run(["schtasks.exe", "/Run", "/TN", this.#taskName]);
    if (start !== 0) throw new Error("could not start the CoForge Daemon user task");
    await this.#local.ensureStarted(config);
  }

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  ensureRunning(): Promise<void> {
    return this.#local.ensureRunning();
  }

  command(operation: "start" | "stop" | "restart"): Promise<void> {
    return this.#local.command(operation);
  }
}

async function runCommand(command: string[]): Promise<number> {
  const process = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await process.exited;
}
