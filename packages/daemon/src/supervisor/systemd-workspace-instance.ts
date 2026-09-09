import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateWorkspaceEndpoint, type WorkspaceInstanceConfig } from "./workspace-instance";
export type { WorkspaceInstanceConfig } from "./workspace-instance";

export type SystemdUserCommand = (args: string[]) => Promise<number>;
export type SystemdUserCapture = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** One user-manager unit is the process-containment seam for one Workspace. */
export class SystemdWorkspaceInstance {
  readonly unitName: string;
  readonly unitPath: string;

  constructor(
    private readonly config: WorkspaceInstanceConfig,
    private readonly run: SystemdUserCommand,
    private readonly write: (path: string, content: string) => Promise<void> = async (
      path,
      content,
    ) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    },
    private readonly capture: SystemdUserCapture = async (args) => {
      const process = Bun.spawn(["systemctl", "--user", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      return { code: await process.exited, stdout: await new Response(process.stdout).text() };
    },
  ) {
    const identity = createHash("sha256")
      .update(`${config.stateRoot}\0${config.workspaceId}`)
      .digest("hex")
      .slice(0, 24);
    this.unitName = `coforge-workspace-${identity}.service`;
    this.unitPath = join(config.unitDirectory, this.unitName);
  }

  async ensureStarted(): Promise<number> {
    await this.write(this.unitPath, workspaceUnit(this.config));
    await this.#runChecked(["daemon-reload"], "reload the systemd user manager");
    const state = await this.#show();
    if (state.active && state.mainPid > 0) return state.mainPid;
    await this.#runChecked(["start", this.unitName], `start ${this.unitName}`);
    return (await this.#waitForMainPid()).mainPid;
  }

  async stop(): Promise<void> {
    const state = await this.#show();
    if (state.exists) await this.#runChecked(["stop", this.unitName], `stop ${this.unitName}`);
    await rm(this.unitPath, { force: true });
    await this.#runChecked(["daemon-reload"], "reload the systemd user manager");
  }

  async identity(): Promise<{ mainPid: number; active: boolean; invocationId: string } | null> {
    const state = await this.#show();
    return state.exists
      ? { mainPid: state.mainPid, active: state.active, invocationId: state.invocationId }
      : null;
  }

  async #show(): Promise<{
    exists: boolean;
    active: boolean;
    mainPid: number;
    invocationId: string;
  }> {
    const result = await this.capture([
      "show",
      this.unitName,
      "--property=ActiveState",
      "--property=MainPID",
      "--property=LoadState",
      "--property=InvocationID",
    ]);
    const properties = new Map<string, string>();
    for (const line of result.stdout.trim().split("\n")) {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      if (separator < 1 || properties.has(key))
        throw new Error(`invalid systemd observation for ${this.unitName}`);
      properties.set(key, line.slice(separator + 1));
    }
    if (properties.get("LoadState") === "not-found")
      return { exists: false, active: false, mainPid: 0, invocationId: "" };
    const pid = properties.get("MainPID") ?? "";
    const invocationId = properties.get("InvocationID") ?? "";
    if (
      result.code !== 0 ||
      !properties.get("LoadState") ||
      !properties.get("ActiveState") ||
      !/^\d+$/.test(pid) ||
      !Number.isSafeInteger(Number(pid)) ||
      ((Number(pid) > 0 || properties.get("ActiveState") === "active") &&
        !/^[0-9a-f]{32}$/.test(invocationId))
    )
      throw new Error(`could not query systemd state for ${this.unitName}`);
    return {
      exists: true,
      active: properties.get("ActiveState") === "active",
      mainPid: Number(pid),
      invocationId,
    };
  }

  async #waitForMainPid(): Promise<{ mainPid: number; active: boolean }> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = await this.#show();
      if (state.active && state.mainPid > 0) return state;
      await Bun.sleep(50);
    }
    throw new Error(`Workspace unit ${this.unitName} did not become ready`);
  }

  async #runChecked(args: string[], action: string): Promise<void> {
    const code = await this.run(args);
    if (code !== 0) throw new Error(`could not ${action}`);
  }
}

export function workspaceUnit(config: WorkspaceInstanceConfig): string {
  validateWorkspaceEndpoint(config.daemonConnectionEndpoint);
  return `[Unit]
Description=CoForge Workspace ${escapeUnit(config.workspaceId)}

[Service]
Environment="COFORGE_DAEMON_HOME=${escapeUnit(config.stateDirectory)}"
${config.supervisorSocketPath ? `Environment="COFORGE_SUPERVISOR_SOCKET=${escapeUnit(config.supervisorSocketPath)}"\n` : ""}${config.daemonConnectionEndpoint ? `Environment="COFORGE_DAEMON_CONNECTION_ENDPOINT=${escapeUnit(config.daemonConnectionEndpoint)}"\n` : ""}ExecStart=${escapeUnit(config.executablePath)} __workspace-daemon --socket ${escapeUnit(config.socketPath)} --state-directory ${escapeUnit(config.stateDirectory)}
Restart=on-failure
RestartSec=1s
KillMode=mixed
SendSIGKILL=yes
TimeoutStopSec=10s

[Install]
`;
}

function escapeUnit(value: string): string {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0"))
    throw new Error("invalid systemd unit value");
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll(" ", "\\x20");
}
