import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher } from "./launcher";

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
    run?: CommandRunner;
  }) {
    this.#taskName = options.taskName ?? "CoForge Daemon";
    this.#run = options.run ?? runCommand;
    this.#command = `"${options.executablePath.replaceAll('"', '""')}" --socket ${options.socketPath}`;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
    });
  }

  async ensureStarted(credential: string): Promise<void> {
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
    await this.#local.ensureStarted(credential);
  }
}

async function runCommand(command: string[]): Promise<number> {
  const process = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await process.exited;
}
