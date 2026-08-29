import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher, DaemonStopper, DaemonWorkspaceConfig } from "./launcher";

type CommandRunner = (command: string[]) => Promise<number>;

export class WindowsUserDaemonHost implements DaemonLauncher, DaemonStopper {
  readonly #taskName: string;
  readonly #run: CommandRunner;
  readonly #local: LocalDaemonLauncher;
  readonly #command: string;

  constructor(options: {
    taskName?: string;
    executablePath: string;
    socketPath: string;
    stateDirectory?: string;
    cloudWebSocketEndpoint?: string;
    run?: CommandRunner;
  }) {
    this.#taskName = options.taskName ?? "CoForge Daemon";
    this.#run = options.run ?? runCommand;
    const daemonCommand = `"${options.executablePath.replaceAll('"', '""')}" --socket ${options.socketPath}${options.stateDirectory ? ` --state-directory "${options.stateDirectory}"` : ""}`;
    this.#command = options.cloudWebSocketEndpoint
      ? `cmd.exe /d /s /c "set COFORGE_CLOUD_WEBSOCKET_ENDPOINT=${options.cloudWebSocketEndpoint}&& ${daemonCommand}"`
      : daemonCommand;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
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

  ensureRunning(): Promise<void> {
    return this.#local.ensureRunning();
  }

  command(operation: "start" | "stop" | "restart"): Promise<void> {
    return this.#local.command(operation);
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
