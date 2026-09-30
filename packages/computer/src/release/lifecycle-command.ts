import { homedir } from "node:os";
import { Command, CommanderError } from "commander";

import { configureComputerLogger } from "#src/logging/computer-logger";
import { resolveComputerConfigDirectory } from "#src/paths";
import { COFORGE_COMPUTER_VERSION } from "#src/version";
import {
  LIFECYCLE_ERROR_CODE,
  LIFECYCLE_EXIT_CODE,
  LIFECYCLE_PROTOCOL,
  type LifecycleAck,
  type LifecycleError,
  type LifecycleHold,
  type LifecycleStatus,
} from "./installer-contract";
import {
  createSupervisorControl,
  resolveSupervisorPaths,
  SupervisorNotRunningError,
  type SupervisorControl,
} from "./supervisor-control";

/**
 * `coforge-computer __lifecycle <command>`: the versioned JSON surface through which the
 * separately released installer controls this Computer. Every call prints exactly one JSON object
 * on stdout and nothing else, so the installer never parses human text; the exit status is one of
 * `LIFECYCLE_EXIT_CODE`.
 */
export async function runLifecycleCommand(args: readonly string[]): Promise<number> {
  // Logs go to the Computer's own file only, so `coforge-computer logs` shows the pause, hold,
  // release, and resume the installer asked for; stdout carries nothing but the one JSON result.
  const logging = await configureComputerLogger({
    dataDirectory: resolveComputerConfigDirectory({
      platform: process.platform,
      homeDirectory: homedir(),
      environment: process.env,
    }),
    version: COFORGE_COMPUTER_VERSION,
  });
  try {
    return await runCommand(args, createSupervisorControl(resolveSupervisorPaths()));
  } finally {
    await logging.close();
  }
}

async function runCommand(args: readonly string[], control: SupervisorControl): Promise<number> {
  const print = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const ack: LifecycleAck = { lifecycle_protocol: LIFECYCLE_PROTOCOL, ok: true };
  const program = new Command()
    .name("coforge-computer __lifecycle")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.command("protocol").action(() => {
    print({ lifecycle_protocol: LIFECYCLE_PROTOCOL, version: COFORGE_COMPUTER_VERSION });
  });
  program.command("status").action(async () => {
    const status = await control.status();
    print({
      lifecycle_protocol: LIFECYCLE_PROTOCOL,
      version: COFORGE_COMPUTER_VERSION,
      supervisor: status.supervisor,
      bindings: status.bindings.map((binding) => ({
        binding_id: binding.bindingId,
        enabled: binding.enabled,
        running: binding.running,
        process_id: binding.processId,
      })),
      healthy: status.problems.length === 0,
      problems: status.problems,
    } satisfies LifecycleStatus);
  });
  for (const name of ["pause", "resume"] as const)
    program
      .command(name)
      .requiredOption("--request-id <id>")
      .action(async (options: { requestId: string }) => {
        await control[name](options.requestId);
        print(ack);
      });
  program
    .command("hold")
    .requiredOption("--request-id <id>")
    .action(async (options: { requestId: string }) => {
      const outcome = await control.hold(options.requestId);
      print({
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        quiescent: outcome.quiescent,
        elapsed_ms: outcome.elapsedMs,
        busy_agent_count: outcome.busyAgents.length,
      } satisfies LifecycleHold);
    });
  program.command("release").action(async () => {
    await control.release();
    print(ack);
  });
  try {
    await program.parseAsync(args, { from: "user" });
    return LIFECYCLE_EXIT_CODE.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      print(lifecycleError(LIFECYCLE_ERROR_CODE.USAGE, error.message));
      return LIFECYCLE_EXIT_CODE.USAGE;
    }
    print(
      lifecycleError(
        error instanceof SupervisorNotRunningError
          ? LIFECYCLE_ERROR_CODE.SUPERVISOR_NOT_RUNNING
          : LIFECYCLE_ERROR_CODE.FAILED,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return LIFECYCLE_EXIT_CODE.FAILED;
  }
}

function lifecycleError(code: string, message: string): LifecycleError {
  return { lifecycle_protocol: LIFECYCLE_PROTOCOL, ok: false, code, message };
}
