import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedRuntimeIdentity } from "@coforge/protocol";
import { startDaemonLocalRpcServer } from "../local-rpc";
import { FileDaemonCredentialStore } from "../credentials/credential-store";
import { DaemonConfigStore } from "../persistence/daemon-config";
import { LocalDaemonLauncher } from "../daemon-host/launcher";
import { acquireProcessLock } from "../platform/process-lock";
import { MachineSupervisor, WorkspaceRecoveryError, type BindingStore } from "./machine-supervisor";
import { FileBindingStore } from "./binding-store";
import { getLogger } from "@logtape/logtape";
import { COFORGE_DAEMON_VERSION } from "../version";
import { SystemdWorkspaceInstance } from "./systemd-workspace-instance";
import { COFORGE_DAEMON_SERVER_URL } from "../connection/built-server";

export async function runMachineSupervisor(
  args: string[],
  createBindings: (stateDirectory: string) => BindingStore = (directory) =>
    new FileBindingStore(directory, COFORGE_DAEMON_SERVER_URL),
): Promise<void> {
  const socketPath = args[args.indexOf("--socket") + 1];
  if (!args.includes("--socket") || !socketPath) throw new Error("supervisor requires --socket");
  const stateDirectory = args.includes("--state-directory")
    ? args[args.indexOf("--state-directory") + 1]!
    : dirname(socketPath);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lock = acquireProcessLock(join(stateDirectory, "supervisor-lock.sqlite"));
  try {
    await runWithSupervisorLock(socketPath, stateDirectory, createBindings(stateDirectory));
  } finally {
    lock.release();
  }
}

async function runWithSupervisorLock(
  socketPath: string,
  stateDirectory: string,
  bindings: BindingStore,
): Promise<void> {
  const lockMarker = join(stateDirectory, "supervisor.lock");
  await mkdir(lockMarker, { recursive: true, mode: 0o700 });
  await writeFile(join(lockMarker, "owner"), String(process.pid), { mode: 0o600 });
  const holdPath = join(stateDirectory, "launch-hold");
  const workspaceDirectory = (id: string) =>
    join(stateDirectory, "workspaces", Buffer.from(id).toString("base64url"));
  const children = new Map<
    string,
    { instance: SystemdWorkspaceInstance; identity: ManagedRuntimeIdentity; osInstanceId: string }
  >();
  const childClient = (workspaceId: string) =>
    new LocalDaemonLauncher({
      executablePath: process.execPath,
      socketPath: join(workspaceDirectory(workspaceId), "daemon.sock"),
      spawn: () => {},
    });
  const workspaceInstance = (workspaceId: string) =>
    new SystemdWorkspaceInstance(
      {
        stateRoot: stateDirectory,
        workspaceId,
        executablePath: process.execPath,
        socketPath: join(workspaceDirectory(workspaceId), "daemon.sock"),
        stateDirectory: workspaceDirectory(workspaceId),
        unitDirectory: join(homedir(), ".config", "systemd", "user"),
        supervisorSocketPath: socketPath,
        daemonConnectionEndpoint: Bun.env.COFORGE_DAEMON_CONNECTION_ENDPOINT,
      },
      async (args) => {
        const command = Bun.spawn(["systemctl", "--user", ...args], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        return await command.exited;
      },
    );
  // Stable OS units own processes even if the Coordinator died before readiness.
  // Recovery adopts them through MainPID + the daemon handshake, never by killing PIDs.
  const supervisor = new MachineSupervisor(bindings, {
    async start(binding) {
      if (process.platform !== "linux")
        throw new Error("per-Workspace OS containment is not implemented on this platform");
      const directory = workspaceDirectory(binding.workspaceId);
      // Only the replacement receives the pending request as a cloud ready hint.
      // Local completion still requires the application handshake and durable result.
      const restartRequestIds = (binding.restartResults ?? [])
        .filter((result) => result.status === "completed")
        .map((result) => result.requestId);
      if (binding.restart?.phase === "starting") restartRequestIds.push(binding.restart.requestId);
      const {
        enabled: _enabled,
        restart: _restart,
        restartResults: _results,
        restartRequestIds: _legacy,
        ...config
      } = binding;
      const childConfig = { ...config, restartRequestIds: restartRequestIds.slice(-128) };
      await new DaemonConfigStore(directory).save(childConfig);
      const instance = workspaceInstance(binding.workspaceId);
      const processId = await instance.ensureStarted();
      const observed = await instance.identity();
      if (!observed?.active || observed.mainPid !== processId)
        throw new Error("Workspace OS identity changed during startup");
      const identity = {
        workspaceId: binding.workspaceId,
        computerId: binding.computerId,
        enabled: true,
        processId,
        instanceId: "",
        version: "",
      };
      children.set(binding.workspaceId, {
        instance,
        identity,
        osInstanceId: observed.invocationId,
      });
      const client = childClient(binding.workspaceId);
      const deadline = Date.now() + 30_000;
      try {
        while (Date.now() < deadline) {
          const reported = await client.identity().catch(() => null);
          if (reported?.processId === processId && reported.version === COFORGE_DAEMON_VERSION) {
            const current = await instance.identity();
            if (!current?.active || current.invocationId !== observed.invocationId)
              throw new Error("Workspace OS identity changed during handshake");
            identity.instanceId = reported.daemonId;
            identity.version = reported.version;
            return observed.invocationId;
          }
          await Bun.sleep(50);
        }
        throw new Error(`Workspace ${binding.workspaceId} failed process readiness`);
      } catch (error) {
        // A failed handshake is not permission to kill an adopted live unit.
        children.delete(binding.workspaceId);
        throw error;
      }
    },
    async stop(binding) {
      const child = children.get(binding.workspaceId);
      // Includes recovery after enabled=false was persisted but OS stop was interrupted.
      // systemd sends SIGTERM to the Workspace main, then kills residual cgroup members.
      await (child?.instance ?? workspaceInstance(binding.workspaceId)).stop();
      children.delete(binding.workspaceId);
    },
    async instance(binding) {
      const observed = await workspaceInstance(binding.workspaceId).identity();
      return observed && observed.mainPid > 0 ? observed.invocationId : null;
    },
  });
  const scopedCredentials = (workspaceId: string) =>
    new FileDaemonCredentialStore(workspaceDirectory(workspaceId));
  const snapshot = async () =>
    (await supervisor.snapshot()).map((binding) => {
      const child = children.get(binding.workspaceId);
      return child && binding.instanceId === child.osInstanceId
        ? { ...child.identity, enabled: binding.enabled }
        : {
            workspaceId: binding.workspaceId,
            computerId: binding.computerId,
            enabled: binding.enabled,
            processId: 0,
            instanceId: "",
            version: "",
          };
    });
  let rpc: Awaited<ReturnType<typeof startDaemonLocalRpcServer>> | undefined;
  try {
    try {
      await supervisor.recover();
    } catch (error) {
      if (!(error instanceof WorkspaceRecoveryError)) throw error;
      // Keep local control available for explicit stop/retry; other Workspaces were reconciled.
      getLogger(["coforge", "daemon", "supervisor"]).error(
        "Workspace recovery incomplete: {error}",
        { error },
      );
    }
    if (await Bun.file(holdPath).exists()) await supervisor.pause();
    rpc = await startDaemonLocalRpcServer({
      socketPath,
      version: COFORGE_DAEMON_VERSION,
      validateCredential: async (value) => value.length > 0 && !(await Bun.file(holdPath).exists()),
      credentials: {
        load: (w, c) => scopedCredentials(w).load(w, c),
        save: (w, c, key) => scopedCredentials(w).save(w, c, key),
        delete: (w, c) => scopedCredentials(w).delete(w, c),
      },
      runtime: {
        configure: (config) => supervisor.configure(config),
        async command(method, request) {
          if (method === "daemon:pause") await supervisor.pause();
          else if (method === "daemon:resume") await supervisor.resume();
          else if (method !== "daemon:snapshot") {
            const operation = method.slice("daemon:".length);
            if (operation !== "start" && operation !== "stop" && operation !== "restart")
              throw new Error("unknown lifecycle operation");
            await supervisor.command(
              operation,
              request.workspaceId,
              operation === "restart" ? request.requestId : undefined,
            );
          }
          return snapshot();
        },
      },
    });
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => resolve());
      process.once("SIGINT", () => resolve());
    });
  } finally {
    let cleaned = false;
    try {
      // Startup/adoption failure must not tear down other already-running units.
      if (rpc) await supervisor.shutdown();
      cleaned = true;
    } finally {
      await rpc?.close();
      if (cleaned) await rm(join(lockMarker, "owner"), { force: true });
    }
  }
}
