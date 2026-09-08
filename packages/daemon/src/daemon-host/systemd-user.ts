import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher, DaemonWorkspaceConfig } from "./launcher";

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
    stateDirectory?: string;
    serverUrl?: string;
    daemonConnectionEndpoint?: string;
    serviceName?: string;
    runtimeHomeDirectory?: string;
    writeFile?: (path: string, content: string) => Promise<void>;
    run?: CommandRunner;
  }) {
    const serviceName = options.serviceName ?? "coforge-daemon.service";
    if (!isValidServiceName(serviceName)) throw new Error("invalid systemd user service name");
    this.#unitPath = join(options.homeDirectory, ".config", "systemd", "user", serviceName);
    this.#run = options.run ?? runCommand;
    this.#writeFile =
      options.writeFile ??
      (async (path, content) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      });
    this.#unit = systemdUserUnit(
      options.executablePath,
      options.socketPath,
      options.stateDirectory,
      options.daemonConnectionEndpoint,
      options.runtimeHomeDirectory,
    );
    this.#serviceName = serviceName;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory ?? join(options.homeDirectory, ".coforge", "daemon"),
      serverUrl: options.serverUrl,
    });
  }

  readonly #serviceName: string;

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<void> {
    await this.#writeFile(this.#unitPath, this.#unit);
    await this.#run(["systemctl", "--user", "daemon-reload"]);
    await this.#run(["systemctl", "--user", "enable", this.#serviceName]);
    await this.ensureRunning();
    await this.#local.ensureStarted(config);
  }

  async ensureRunning(): Promise<void> {
    const result = await this.#run(["systemctl", "--user", "start", this.#serviceName]);
    if (result !== 0)
      throw new Error(
        "The systemd user manager could not start CoForge Daemon. Run `coforge-computer foreground` under an external supervisor; CoForge will not detach a fallback process.",
      );
    await this.#local.ensureRunning();
  }

  command(operation: "start" | "stop" | "restart", workspaceId?: string): Promise<void> {
    return this.#local.command(operation, workspaceId);
  }

  async stop(): Promise<void> {
    const result = await this.#run(["systemctl", "--user", "stop", this.#serviceName]);
    if (result !== 0) throw new Error("could not stop the CoForge Daemon user service");
  }
}

export function systemdUserUnit(
  executablePath: string,
  socketPath: string,
  stateDirectory?: string,
  daemonConnectionEndpoint?: string,
  runtimeHomeDirectory?: string,
): string {
  return `[Unit]
Description=CoForge Daemon

[Service]
${runtimeHomeDirectory ? `Environment=HOME=${systemdEscape(runtimeHomeDirectory)}\n` : ""}${daemonConnectionEndpoint ? `Environment=COFORGE_DAEMON_CONNECTION_ENDPOINT=${systemdEscape(daemonConnectionEndpoint)}\n` : ""}ExecStart=${systemdEscape(executablePath)} __daemon --socket ${systemdEscape(socketPath)}${stateDirectory ? ` --state-directory ${systemdEscape(stateDirectory)}` : ""}
Restart=on-failure
RestartSec=2
KillMode=mixed

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

function isValidServiceName(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/.test(value);
}
