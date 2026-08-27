import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher } from "./launcher";

type CommandRunner = (command: string[]) => Promise<number>;

export class SystemdUserDaemonHost implements DaemonLauncher {
  readonly #unitPath: string;
  readonly #run: CommandRunner;
  readonly #writeFile: (path: string, content: string) => Promise<void>;
  readonly #local: LocalDaemonLauncher;
  readonly #unit: string;

  constructor(options: {
    homeDirectory: string;
    executablePath: string;
    socketPath: string;
    writeFile?: (path: string, content: string) => Promise<void>;
    run?: CommandRunner;
  }) {
    this.#unitPath = join(
      options.homeDirectory,
      ".config",
      "systemd",
      "user",
      "coforge-daemon.service",
    );
    this.#run = options.run ?? runCommand;
    this.#writeFile =
      options.writeFile ??
      (async (path, content) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      });
    this.#unit = systemdUserUnit(options.executablePath, options.socketPath);
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
    });
  }

  async ensureStarted(credential: string): Promise<void> {
    await this.#writeFile(this.#unitPath, this.#unit);
    await this.#run(["systemctl", "--user", "daemon-reload"]);
    await this.#run(["systemctl", "--user", "enable", "coforge-daemon.service"]);
    const result = await this.#run(["systemctl", "--user", "start", "coforge-daemon.service"]);
    if (result !== 0) throw new Error("could not start the CoForge Daemon user service");
    await this.#local.ensureStarted(credential);
  }
}

export function systemdUserUnit(executablePath: string, socketPath: string): string {
  return `[Unit]
Description=CoForge Daemon

[Service]
ExecStart=${systemdEscape(executablePath)} --socket ${systemdEscape(socketPath)}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

async function runCommand(command: string[]): Promise<number> {
  const process = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await process.exited;
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}
