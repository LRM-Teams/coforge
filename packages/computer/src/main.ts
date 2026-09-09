#!/usr/bin/env bun

export {};

// Dispatch before importing either runtime so Agent commands never initialize
// Computer logging, Daemon sockets, or Workspace recovery.
if (Bun.argv[2] === "__agent-cli") {
  const { runAgentCli } = await import("@coforge/cli/runner");
  await runAgentCli(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__daemon") {
  const { runMachineSupervisor } = await import("@coforge/daemon");
  await runMachineSupervisor(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__managed-agent") {
  const { runLaunchdAgent } = await import("@coforge/daemon");
  await runLaunchdAgent(Bun.argv[3]!);
} else if (Bun.argv[2] === "__workspace-daemon") {
  const { runDaemon } = await import("@coforge/daemon");
  await runDaemon(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__upgrade") {
  const { runUpgradeCoordinator } = await import("./release/upgrade-coordinator");
  await runUpgradeCoordinator(Bun.argv.slice(3));
} else {
  const { runComputer } = await import("./cli");
  await runComputer();
}
