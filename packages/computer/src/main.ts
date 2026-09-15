#!/usr/bin/env bun

export {};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const { COFORGE_COMPUTER_VERSION } = await import("./version");
  await runDaemon(Bun.argv.slice(3), COFORGE_COMPUTER_VERSION);
} else if (Bun.argv[2] === "__upgrade") {
  const { runUpgradeCoordinator } = await import("./release/upgrade-coordinator");
  await runUpgradeCoordinator(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__remote-upgrade") {
  const requestId = Bun.argv[Bun.argv.indexOf("--request-id") + 1];
  const version = Bun.argv[Bun.argv.indexOf("--version") + 1];
  if (!requestId || !UUID_PATTERN.test(requestId))
    throw new Error("remote upgrade requires a valid UUID request ID");
  Bun.env.COFORGE_UPGRADE_REQUEST_ID = requestId;
  if (!version) throw new Error("remote upgrade requires --version");
  Bun.env.COFORGE_UPGRADE_VERSION = version;
  const { runRemoteUpgrade } = await import("./cli");
  await runRemoteUpgrade();
} else {
  const { runComputer } = await import("./cli");
  await runComputer();
}
