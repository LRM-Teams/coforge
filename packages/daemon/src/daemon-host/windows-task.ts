import { LocalDaemonLauncher, type LocalDaemonLauncherOptions } from "./launcher";
import type { DaemonLauncher, DaemonWorkspaceConfig } from "./launcher";
import { unlink } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { escapeXmlText } from "#src/platform/xml-escape";

type CommandRunner = (command: string[]) => Promise<number>;
type TaskXmlWriter = (path: string, content: string) => Promise<void>;

export type WindowsDaemonTaskXmlInput = {
  userId: string;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  daemonConnectionEndpoint?: string;
};

/**
 * Task Scheduler 1.2 XML for the machine-level Coordinator. Uses an interactive,
 * least-privilege LogonTrigger so `schtasks /Create /XML` succeeds without elevation —
 * the `/SC ONLOGON` CLI form is refused for non-admin users on current Windows builds.
 * RestartOnFailure approximates systemd `Restart=on-failure` / launchd KeepAlive for the
 * Coordinator process itself (Workspace children still use Coordinator reconcile).
 */
export function windowsDaemonTaskXml(input: WindowsDaemonTaskXmlInput): string {
  const daemonArgs = [
    "__daemon",
    "--socket",
    input.socketPath,
    ...(input.stateDirectory ? ["--state-directory", input.stateDirectory] : []),
  ].join(" ");
  const exec = input.daemonConnectionEndpoint
    ? {
        command: "cmd.exe",
        arguments: `/d /s /c "set COFORGE_DAEMON_CONNECTION_ENDPOINT=${input.daemonConnectionEndpoint}&& ${quoteCmdPath(input.executablePath)} ${daemonArgs}"`,
      }
    : { command: input.executablePath, arguments: daemonArgs };
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXmlText(input.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXmlText(input.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXmlText(exec.command)}</Command>
      <Arguments>${escapeXmlText(exec.arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Resolves `DOMAIN\\user` for Task Scheduler principals; falls back to the OS username. */
export function windowsTaskUserId(
  environment: NodeJS.ProcessEnv = process.env,
  username: string = userInfo().username,
): string {
  const domain = environment.USERDOMAIN?.trim();
  const envUser = environment.USERNAME?.trim();
  if (domain && envUser) return `${domain}\\${envUser}`;
  return username;
}

export class WindowsUserDaemonHost implements DaemonLauncher {
  readonly #taskName: string;
  readonly #run: CommandRunner;
  readonly #writeTaskXml: TaskXmlWriter;
  readonly #local: LocalDaemonLauncher;
  readonly #xml: string;
  readonly #removeTaskXml: (path: string) => Promise<void>;

  constructor(options: {
    taskName?: string;
    executablePath: string;
    socketPath: string;
    stateDirectory?: string;
    serverUrl?: string;
    daemonConnectionEndpoint?: string;
    userId?: string;
    run?: CommandRunner;
    writeTaskXml?: TaskXmlWriter;
    removeTaskXml?: (path: string) => Promise<void>;
    connect?: LocalDaemonLauncherOptions["connect"];
    timeoutMilliseconds?: number;
  }) {
    this.#taskName = options.taskName ?? "CoForge Daemon";
    this.#run = options.run ?? runCommand;
    this.#writeTaskXml = options.writeTaskXml ?? writeUtf16XmlFile;
    this.#removeTaskXml = options.removeTaskXml ?? removeFileQuietly;
    this.#xml = windowsDaemonTaskXml({
      userId: options.userId ?? windowsTaskUserId(),
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory,
      daemonConnectionEndpoint: options.daemonConnectionEndpoint,
    });
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
    // Prefer the user logon task when registration is allowed. When Create/Run is refused,
    // fall back to an already-running foreground supervisor — never detach an unmanaged process.
    if (await this.#installAndRun()) {
      await this.#local.ensureStarted(config);
      return;
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
    if (!(await this.#installAndRun()))
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
    if (!(await this.#installAndRun()))
      throw new Error("could not restart the CoForge Daemon user task");
    await this.#local.ensureRunning();
  }

  async #installAndRun(): Promise<boolean> {
    const xmlPath = join(tmpdir(), `coforge-daemon-task-${crypto.randomUUID()}.xml`);
    try {
      await this.#writeTaskXml(xmlPath, this.#xml);
      const created = await this.#run([
        "schtasks.exe",
        "/Create",
        "/TN",
        this.#taskName,
        "/XML",
        xmlPath,
        "/F",
      ]);
      if (created !== 0) return false;
      return (await this.#run(["schtasks.exe", "/Run", "/TN", this.#taskName])) === 0;
    } finally {
      await this.#removeTaskXml(xmlPath);
    }
  }
}

async function runCommand(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await child.exited;
}

async function writeUtf16XmlFile(path: string, content: string): Promise<void> {
  // schtasks /Create /XML requires UTF-16; the BOM lets it detect the encoding.
  await Bun.write(path, Buffer.from(`\uFEFF${content}`, "utf16le"));
}

async function removeFileQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}

function quoteCmdPath(path: string): string {
  return `"${path.replaceAll('"', '""')}"`;
}
