import { readFile, realpath, stat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import {
  acquireProcessLock,
  FileBindingStore,
  LocalDaemonLauncher,
  resolveDaemonExecutablePath,
  workspaceHealthJournalPath,
  workspaceStateDirectory,
  WorkspaceHealthJournal,
} from "@lrm/coforge-daemon";
import { resolveDaemonSocketPath } from "../paths";
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

export type CreateStatusPortsInput = {
  platform: SupportedStatusPlatform;
  installDirectory: string;
  stateDirectory: string;
  releaseFeedUrl: string;
  serverUrl: string;
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
      return probeWindowsCoordinator(coordinatorLabel);
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
        return isSqliteLockContention(error) ? "held" : "unknown";
      }
    },
    async readSupervisorLockOwner(): Promise<number | null> {
      try {
        const text = (await readFile(supervisorLockOwnerPath, "utf8")).trim();
        const pid = Number(text);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    },
    listLeftoverUpgradeJobs:
      input.platform === "darwin"
        ? { supported: true, list: listDarwinLeftoverUpgradeJobs }
        : { supported: false, list: async () => [] },
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

function isSqliteLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}
