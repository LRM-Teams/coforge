import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher, DaemonStopper, DaemonWorkspaceConfig } from "./launcher";

type CommandRunner = (command: string[]) => Promise<number>;

export type LaunchdDaemonHostOptions = {
  label: string;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  cloudWebSocketEndpoint?: string;
  homeDirectory: string;
  uid: number;
  writeFile?: (path: string, content: string) => Promise<void>;
  run?: CommandRunner;
};

export class LaunchdDaemonHost implements DaemonLauncher, DaemonStopper {
  readonly #plistPath: string;
  readonly #run: CommandRunner;
  readonly #writeFile: (path: string, content: string) => Promise<void>;
  readonly #options: LaunchdDaemonHostOptions;
  readonly #local: LocalDaemonLauncher;

  constructor(options: LaunchdDaemonHostOptions) {
    this.#options = options;
    this.#plistPath = join(
      options.homeDirectory,
      "Library",
      "LaunchAgents",
      `${options.label}.plist`,
    );
    this.#run = options.run ?? runCommand;
    this.#writeFile =
      options.writeFile ??
      (async (path, content) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      });
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
    });
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<void> {
    await this.ensureInstalled();
    await this.#local.ensureStarted(config);
  }

  ensureRunning(): Promise<void> {
    return this.#local.ensureRunning();
  }

  command(operation: "start" | "stop" | "restart"): Promise<void> {
    return this.#local.command(operation);
  }

  async stop(): Promise<void> {
    const target = `gui/${this.#options.uid}/${this.#options.label}`;
    // Booting the user agent out prevents KeepAlive from immediately relaunching it.
    const result = await this.#run(["launchctl", "bootout", target]);
    if (result !== 0) throw new Error("could not stop the CoForge Daemon");
  }

  async ensureInstalled(): Promise<void> {
    await this.#writeFile(this.#plistPath, launchdPlist(this.#options));
    const target = `gui/${this.#options.uid}/${this.#options.label}`;
    if ((await this.#run(["launchctl", "print", target])) === 0) {
      await this.#run(["launchctl", "kickstart", "-k", target]);
      return;
    }
    const result = await this.#run([
      "launchctl",
      "bootstrap",
      `gui/${this.#options.uid}`,
      this.#plistPath,
    ]);
    if (result !== 0) throw new Error("could not register the CoForge Daemon with launchd");
  }
}

export function launchdPlist(input: {
  label: string;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  cloudWebSocketEndpoint?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(input.label)}</string>
  ${input.cloudWebSocketEndpoint ? `<key>EnvironmentVariables</key><dict><key>COFORGE_CLOUD_WEBSOCKET_ENDPOINT</key><string>${xml(input.cloudWebSocketEndpoint)}</string></dict>` : ""}
  <key>ProgramArguments</key>
  <array><string>${xml(input.executablePath)}</string><string>--socket</string><string>${xml(input.socketPath)}</string>${input.stateDirectory ? `<string>--state-directory</string><string>${xml(input.stateDirectory)}</string>` : ""}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

async function runCommand(command: string[]): Promise<number> {
  const process = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await process.exited;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
