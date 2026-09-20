import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { nativeCommandDiagnostic, type NativeCommandResult } from "../platform/native-command";
import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher, DaemonWorkspaceConfig } from "./launcher";

type CommandRunner = (command: string[]) => Promise<NativeCommandResult>;

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
    await this.#systemctl("start");
    await this.#local.ensureRunning();
  }

  command(
    operation: "start" | "stop" | "restart",
    workspaceId?: string,
  ): Promise<ManagedRuntimeIdentity[]> {
    return this.#local.command(operation, workspaceId);
  }

  async stop(): Promise<void> {
    await this.#systemctl("stop");
  }

  /**
   * The in-place replacement `coforge-computer restart --supervisor` uses to restart the
   * Coordinator process itself (not a Workspace runtime). `reset-failed` clears any earlier
   * failed-state latch a previous crash may have left on the unit - its own exit code is
   * ignored, since there is usually nothing to reset - so a stale failure never blocks this
   * restart; `restart` then does the actual stop-and-start in one systemd transaction.
   */
  async restart(): Promise<void> {
    await this.#run(["systemctl", "--user", "reset-failed", this.#serviceName]);
    await this.#systemctl("restart");
    await this.#local.ensureRunning();
  }

  /** Runs one `systemctl --user` verb against this Daemon's unit, turning a refusal into the
   * reason systemd itself printed. Every caller below goes through here: before this, a failure
   * anywhere in the unit lifecycle surfaced as one fixed sentence about foreground supervision,
   * which left a person with nothing to act on when the real cause was something else entirely -
   * most often a `su`/`sudo` shell that has no user bus at all. */
  async #systemctl(verb: "start" | "stop" | "restart"): Promise<void> {
    const result = await this.#run(["systemctl", "--user", verb, this.#serviceName]);
    if (result.code !== 0) throw systemctlFailure(verb, this.#serviceName, result);
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

/**
 * What a person should do next, chosen from what systemd refused with. `systemctl --user` needs
 * this user's own session bus, so it fails outright in a `su` or `sudo` shell - the session that
 * produced the 2026-09-20 upgrade failure on a shared Linux host - and that failure looks nothing
 * like a Daemon that is genuinely supervised from the foreground.
 */
function systemctlRemedy(diagnostic: string, unit: string): string {
  if (/failed to connect to bus|no medium found/i.test(diagnostic))
    return `This shell has no systemd user session, which a \`su\` or \`sudo\` shell never gets. Open this user's own login session - \`ssh <user>@<host>\`, or \`machinectl shell <user>@\` - and run the command there.`;
  if (/not loaded|not found|no such unit/i.test(diagnostic))
    return "No CoForge Daemon user service is installed on this Computer. Install and start one with `coforge-computer start`, or control the Daemon through the external supervisor that runs it.";
  return `Check \`systemctl --user status ${unit}\` for the unit's own account of it.`;
}

function systemctlFailure(verb: string, unit: string, result: NativeCommandResult): Error {
  const diagnostic = nativeCommandDiagnostic(result.stderr);
  const attempt = `\`systemctl --user ${verb} ${unit}\` failed (${result.code})`;
  const reported = diagnostic
    ? `${attempt}: ${/[.!?]$/.test(diagnostic) ? diagnostic : `${diagnostic}.`}`
    : `${attempt}.`;
  return new Error(`${reported} ${systemctlRemedy(diagnostic, unit)}`);
}

async function runCommand(command: string[]): Promise<NativeCommandResult> {
  const child = Bun.spawn(command, {
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stdout: "", stderr };
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function isValidServiceName(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/.test(value);
}
