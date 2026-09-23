#!/usr/bin/env bun

export {};

// Dispatch before importing either runtime so Agent commands never initialize
// Computer logging, Daemon sockets, or Workspace recovery.
if (Bun.argv[2] === "__agent-cli") {
  const { runAgentCli } = await import("@lrm/coforge/runner");
  await runAgentCli(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__daemon") {
  const { runMachineSupervisor } = await import("@lrm/coforge-daemon");
  // Belt and braces: shutdown here is fully awaited - `runMachineSupervisor` only
  // resolves after every Coordinator-owned background wait (the upgrade receipt watch, in
  // particular) has been cancelled and its logging disposed. Exiting explicitly the moment it
  // resolves means a background wait this entrypoint failed to cancel can no longer keep the
  // process alive past its own shutdown, the way an uncancelled one did on 2026-09-17.
  try {
    await runMachineSupervisor(Bun.argv.slice(3));
    process.exit(process.exitCode ?? 0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else if (Bun.argv[2] === "__managed-agent") {
  const { runLaunchdAgent } = await import("@lrm/coforge-daemon");
  // No explicit exit added here: `runLaunchdAgent`'s own promise resolves as soon as its relay
  // socket connects, long before the relayed Agent process (or the socket) ends - shutdown is not
  // "fully awaited" by this call, unlike `__daemon`/`__workspace-daemon` below. The process
  // already terminates through the `process.exit` calls inside `runLaunchdAgent` itself, at each
  // real end of life (child exit, socket close, socket error); exiting here too would kill the
  // relay the moment it connects.
  await runLaunchdAgent(Bun.argv[3]!);
} else if (Bun.argv[2] === "__workspace-daemon") {
  const { runDaemon } = await import("@lrm/coforge-daemon");
  const { COFORGE_COMPUTER_VERSION } = await import("./version");
  // Belt and braces, same reasoning as `__daemon`: `runDaemon` only resolves once its
  // own SIGINT/SIGTERM shutdown has stopped every Workspace runtime, closed the Agent proxy and
  // local RPC server, and disposed logging.
  try {
    await runDaemon(Bun.argv.slice(3), COFORGE_COMPUTER_VERSION);
    process.exit(process.exitCode ?? 0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else if (Bun.argv[2] === "__upgrade") {
  const { runUpgradeCoordinator } = await import("./release/upgrade-coordinator");
  await runUpgradeCoordinator(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__remote-upgrade") {
  // The operation is built once, here, from arguments alone; nothing downstream reads the
  // environment for its identity.
  const { parseRemoteUpgradeOperation } = await import("./release/upgrade-operation");
  const operation = parseRemoteUpgradeOperation(Bun.argv.slice(2));
  const { runRemoteUpgrade } = await import("./cli");
  await runRemoteUpgrade(operation);
} else {
  const { runComputer } = await import("./cli");
  await runComputer();
}
