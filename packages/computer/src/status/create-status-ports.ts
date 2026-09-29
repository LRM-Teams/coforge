import { readFile, realpath, stat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import {
  acquireProcessLock,
  FileBindingStore,
  isLockContention,
  LocalDaemonLauncher,
  resolveDaemonExecutablePath,
  workspaceHealthJournalPath,
  workspaceSocketPath,
  workspaceStateDirectory,
  WorkspaceHealthJournal,
} from "@lrm/coforge-daemon";
import type { FileComputerConfig } from "#src/local-config";
import { resolveDaemonSocketPath } from "#src/paths";
import {
  listDarwinLeftoverUpgradeJobs,
  listDarwinWorkspaceAgents,
  probeDarwinCoordinator,
} from "./darwin-status-ports";
import { probeLinuxCoordinator } from "./linux-status-ports";
import { probeWindowsCoordinator } from "./windows-status-ports";
import type {
  ActiveInstallRead,
  BindingsLoad,
  DaemonSnapshotProbe,
  LockState,
  StatusBinding,
  StatusPorts,
  SupportedStatusPlatform,
} from "./types";

const COORDINATOR_LABEL_DARWIN = "cn.coforge.computer.daemon";
const COORDINATOR_SERVICE_LINUX = "coforge-daemon.service";
const COORDINATOR_TASK_WINDOWS = "CoForge Daemon";
/** How long a Workspace process gets to answer its handshake before status reports it unknown. */
const CLOUD_CONNECTION_PROBE_MS = 2_000;

export type CreateStatusPortsInput = {
  platform: SupportedStatusPlatform;
  installDirectory: string;
  stateDirectory: string;
  releaseFeedUrl: string;
  serverUrl: string;
  /** The local Workspace registrations, read only for each binding's slug. */
  registrations: Pick<FileComputerConfig, "listRegistrations">;
  environment?: NodeJS.ProcessEnv;
};

/** Wires the real, read-only adapters `coforge-computer status` runs against on this machine.
 * Nothing here starts, stops, or writes anything except the harmless SQLite lock-file scaffold
 * created and immediately released by `acquireProcessLock` while probing the mutation lock. */
export function createStatusPorts(input: CreateStatusPortsInput): StatusPorts {
  const environment = input.environment ?? process.env;
  const socketPath = resolveDaemonSocketPath({
    platform: input.platform,
    stateDirectory: input.stateDirectory,
  });
  const activeBinaryPath = resolveDaemonExecutablePath({
    installRoot: input.installDirectory,
    platform: input.platform,
  });
  const binaryName = input.platform === "win32" ? "coforge-computer.cmd" : "coforge-computer";
  const machineMutationLockPath = join(input.installDirectory, "machine-mutation-lock.sqlite");
  const supervisorLockOwnerPath = join(input.stateDirectory, "supervisor.lock", "owner");
  const coordinatorLabel =
    input.platform === "darwin"
      ? COORDINATOR_LABEL_DARWIN
      : input.platform === "linux"
        ? COORDINATOR_SERVICE_LINUX
        : COORDINATOR_TASK_WINDOWS;

  return {
    now: () => new Date(),
    platform: input.platform,
    releaseFeedUrl: input.releaseFeedUrl,
    socketPath,
    activeBinaryPath,
    coordinatorLabel,
    async readActiveInstall(): Promise<ActiveInstallRead> {
      return readActiveInstall(join(input.installDirectory, "active.json"));
    },
    async locateBinaryOnPath(): Promise<string | null> {
      return locateBinaryOnPath(input.platform, binaryName, environment.PATH ?? "");
    },
    async resolveRealPath(path: string): Promise<string | null> {
      try {
        return await realpath(path);
      } catch {
        return null;
      }
    },
    async probeCoordinator() {
      if (input.platform === "darwin") return probeDarwinCoordinator(coordinatorLabel);
      if (input.platform === "linux") return probeLinuxCoordinator(coordinatorLabel);
      return probeWindowsCoordinator(coordinatorLabel, {
        resolvePid: async () => {
          try {
            const pid = await readSupervisorLockOwner(supervisorLockOwnerPath);
            return pid !== null && (await windowsPidIsAlive(pid)) ? pid : null;
          } catch {
            return null;
          }
        },
      });
    },
    async probeDaemonSnapshot(): Promise<DaemonSnapshotProbe> {
      const launcher = new LocalDaemonLauncher({
        executablePath: activeBinaryPath,
        socketPath,
        serverUrl: input.serverUrl,
      });
      try {
        const runtimes = await launcher.control("snapshot");
        return {
          reachable: true,
          runtimes: runtimes.map((runtime) => ({
            workspaceId: runtime.workspaceId,
            processId: runtime.processId,
            // The Coordinator answers a Workspace whose start or restart is under way as
            // still connecting.
            ...(runtime.cloudConnection === "connecting" ? { underWay: true } : {}),
          })),
        };
      } catch (error) {
        return { reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async loadBindings(): Promise<BindingsLoad> {
      try {
        const bindings = (await new FileBindingStore(
          input.stateDirectory,
          input.serverUrl,
        ).load()) as StatusBinding[];
        return { ok: true, bindings };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    listWorkspaceAgents:
      input.platform === "darwin"
        ? {
            supported: true,
            list: (bindings) => listDarwinWorkspaceAgents(input.stateDirectory, bindings),
          }
        : { supported: false, list: async () => [] },
    probeMachineMutationLock(): LockState {
      try {
        const lock = acquireProcessLock(machineMutationLockPath);
        lock.release();
        return "free";
      } catch (error) {
        return isLockContention(error) ? "held" : "unknown";
      }
    },
    async readSupervisorLockOwner(): Promise<number | null> {
      return readSupervisorLockOwner(supervisorLockOwnerPath);
    },
    listLeftoverUpgradeJobs:
      input.platform === "darwin"
        ? { supported: true, list: listDarwinLeftoverUpgradeJobs }
        : { supported: false, list: async () => [] },
    async readWorkspaceSlugs() {
      try {
        const registrations = await input.registrations.listRegistrations();
        return new Map(registrations.map((registration) => [registration.id, registration.slug]));
      } catch {
        return new Map();
      }
    },
    // Bounded by the handshake itself, which closes its socket at the deadline: a Workspace that
    // stalls cannot keep `status` alive after it printed.
    readCloudConnection: (workspaceId) =>
      new LocalDaemonLauncher({
        executablePath: activeBinaryPath,
        socketPath: workspaceSocketPath(input.stateDirectory, workspaceId),
        serverUrl: input.serverUrl,
      }).cloudConnection(CLOUD_CONNECTION_PROBE_MS),
    async readWorkspaceHealth(workspaceId) {
      try {
        const directory = workspaceStateDirectory(input.stateDirectory, workspaceId);
        return await new WorkspaceHealthJournal(workspaceHealthJournalPath(directory)).state();
      } catch {
        // A missing or unreadable health journal is not evidence of a problem - it reads as a
        // fresh, healthy Workspace, the same way `WorkspaceHealthJournal` itself treats it.
        return { status: "ok" };
      }
    },
  };
}

async function readSupervisorLockOwner(path: string): Promise<number | null> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readActiveInstall(path: string): Promise<ActiveInstallRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "corrupt", error: "active.json is not valid JSON" };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schema_version?: unknown }).schema_version !== 1 ||
    typeof (value as { current?: unknown }).current !== "string" ||
    !(
      (value as { previous?: unknown }).previous === null ||
      typeof (value as { previous?: unknown }).previous === "string"
    )
  ) {
    return { kind: "corrupt", error: "active.json has an unexpected shape" };
  }
  const active = value as { current: string; previous: string | null };
  return { kind: "present", current: active.current, previous: active.previous };
}

async function locateBinaryOnPath(
  platform: SupportedStatusPlatform,
  binaryName: string,
  pathEnvironment: string,
): Promise<string | null> {
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of pathEnvironment.split(delimiter)) {
    if (!directory) continue;
    const candidate =
      platform === "win32" ? win32.join(directory, binaryName) : posix.join(directory, binaryName);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Best-effort liveness check for a Windows PID via `tasklist` (no mutation). */
export async function windowsPidIsAlive(pid: number): Promise<boolean> {
  const child = Bun.spawn(["tasklist.exe", "/FI", `PID eq ${pid}`, "/NH"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) return false;
  return new RegExp(`\\b${pid}\\b`).test(stdout);
}
