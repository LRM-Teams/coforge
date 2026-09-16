#!/usr/bin/env bun

export {};

// Dispatch before importing either runtime so Agent commands never initialize
// Computer logging, Daemon sockets, or Workspace recovery.
if (Bun.argv[2] === "__agent-cli") {
  const { runAgentCli } = await import("@lrm/coforge/runner");
  await runAgentCli(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__daemon") {
  const { runMachineSupervisor } = await import("@lrm/coforge-daemon");
  await runMachineSupervisor(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__managed-agent") {
  const { runLaunchdAgent } = await import("@lrm/coforge-daemon");
  await runLaunchdAgent(Bun.argv[3]!);
} else if (Bun.argv[2] === "__workspace-daemon") {
  const { runDaemon } = await import("@lrm/coforge-daemon");
  const { COFORGE_COMPUTER_VERSION } = await import("./version");
  await runDaemon(Bun.argv.slice(3), COFORGE_COMPUTER_VERSION);
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
