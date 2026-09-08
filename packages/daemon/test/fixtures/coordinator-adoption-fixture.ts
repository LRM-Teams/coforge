// Controlled replacement for the Workspace role only. Coordinator, OS unit
// adapter and local RPC are production code. This is not a model-agent E2E.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runMachineSupervisor } from "../../src/supervisor/run-supervisor";
import { startDaemonLocalRpcServer } from "../../src/local-rpc";
import { InMemoryDaemonCredentialStore } from "../../src/credentials/credential-store";
import { COFORGE_DAEMON_VERSION } from "../../src/version";
import { FileBindingStore } from "../../src/supervisor/binding-store";

const [role, ...args] = Bun.argv.slice(2);
if (role === "__daemon") {
  await runMachineSupervisor(args, (directory) => {
    const store = new FileBindingStore(directory);
    return {
      load: () => store.load(),
      async save(bindings) {
        const a = bindings.find((binding) => binding.workspaceId === "a");
        const phase =
          a?.restart?.phase ??
          (a?.restartResults?.at(-1)?.status === "completed" ? "completed" : undefined);
        if (phase === "starting" && (await Bun.file(join(directory, "reject-starting")).exists()))
          throw new Error("controlled restart persistence failure");
        const path = join(directory, "restart-cutpoint.json");
        const cut = await Bun.file(path)
          .json()
          .catch(() => null);
        const requestId = a?.restart?.requestId ?? a?.restartResults?.at(-1)?.requestId;
        const crash = async (when: string) => {
          if (cut?.when !== when || cut?.phase !== phase || cut?.requestId !== requestId) return;
          await rm(path);
          await Bun.write(join(directory, "cutpoint-reached"), `${when}:${phase}`);
          process.kill(process.pid, "SIGKILL");
        };
        await crash("before");
        await store.save(bindings);
        await crash("after");
      },
    };
  });
} else if (role === "agent") {
  await Bun.write(join(args[0]!, "agent.ready"), String(process.pid));
  await Bun.sleep(3_600_000);
} else if (role === "__workspace-daemon") {
  const directory = args[args.indexOf("--state-directory") + 1]!;
  const socketPath = args[args.indexOf("--socket") + 1]!;
  if (!directory || !socketPath) throw new Error("missing fixture args");
  await mkdir(directory, { recursive: true });
  const child = Bun.spawn([process.execPath, "agent", directory], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  while (
    Number(
      await Bun.file(join(directory, "agent.ready"))
        .text()
        .catch(() => ""),
    ) !== child.pid
  ) {
    if (child.exitCode !== null) throw new Error("fixture Agent exited");
    await Bun.sleep(10);
  }
  await Bun.write(join(directory, "before-handshake"), String(process.pid));
  // Test gate is in the replacement Workspace, never in a production endpoint.
  while (!(await Bun.file(join(directory, "allow-handshake")).exists())) await Bun.sleep(10);
  const rpc = await startDaemonLocalRpcServer({
    socketPath,
    version: COFORGE_DAEMON_VERSION,
    credentials: new InMemoryDaemonCredentialStore(),
    validateCredential: () => true,
    runtime: {},
  });
  await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
  await rpc.close();
} else throw new Error("unknown fixture role");
