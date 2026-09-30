import { homedir } from "node:os";
import { DaemonCommandRejectedError } from "@lrm/coforge-daemon";
import { UPGRADE_ERROR_CODE_PATTERN } from "@lrm/coforge-sdk/internal";
import { Command, CommanderError } from "commander";

import { configureComputerLogger } from "#src/logging/computer-logger";
import { resolveComputerConfigDirectory } from "#src/paths";
import { COFORGE_COMPUTER_VERSION } from "#src/version";
import {
  CoordinatorNotRunningError,
  createCoordinatorControl,
  type CoordinatorControl,
} from "./coordinator-control";
import {
  LIFECYCLE_ERROR_CODE,
  LIFECYCLE_EXIT_CODE,
  LIFECYCLE_PROTOCOL,
  type LifecycleAck,
  type LifecycleError,
  type LifecycleHold,
  type LifecycleStatus,
} from "./installer-contract";
import { resolveUpgradeCoordinatorPaths } from "./upgrade-runner";

/**
 * `coforge-computer __lifecycle <command>`: the versioned JSON surface through which the
 * separately released installer controls this Computer. Every call prints exactly one JSON object
 * on stdout and nothing else, so the installer never parses human text; the exit status is one of
 * `LIFECYCLE_EXIT_CODE`.
 */
export async function runLifecycleCommand(args: readonly string[]): Promise<number> {
  // Logs go to the Computer's own file only, so `coforge-computer logs` shows what the installer
  // asked for; stdout carries nothing but the one JSON result.
  const logging = await configureComputerLogger({
    dataDirectory: resolveComputerConfigDirectory({
      platform: process.platform,
      homeDirectory: homedir(),
      environment: process.env,
    }),
    version: COFORGE_COMPUTER_VERSION,
  });
  try {
    return await runCommand(args, createCoordinatorControl(resolveUpgradeCoordinatorPaths()));
  } finally {
    await logging.close();
  }
}

async function runCommand(args: readonly string[], control: CoordinatorControl): Promise<number> {
  const print = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
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
  const ack: LifecycleAck = { lifecycle_protocol: LIFECYCLE_PROTOCOL, ok: true };
  program
    .command("pause")
    .requiredOption("--request-id <id>")
    .action(async (options: { requestId: string }) => {
      await control.pause(options.requestId);
      print(ack);
    });
  program
    .command("hold")
    .requiredOption("--request-id <id>")
    .action(async () => {
      const outcome = await control.hold();
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
  program
    .command("resume")
    .requiredOption("--request-id <id>")
    .action(async (options: { requestId: string }) => {
      await control.resume(options.requestId);
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
    print(lifecycleError(failureCode(error), errorMessage(error)));
    return LIFECYCLE_EXIT_CODE.FAILED;
  }
}

/** A Coordinator refusal keeps its own code, so the installer sees the same reason the product's
 * own upgrade would have (`UPGRADE_LAUNCHES_PAUSED`, for example). */
function failureCode(error: unknown): string {
  if (error instanceof CoordinatorNotRunningError)
    return LIFECYCLE_ERROR_CODE.SUPERVISOR_NOT_RUNNING;
  if (
    error instanceof DaemonCommandRejectedError &&
    UPGRADE_ERROR_CODE_PATTERN.test(error.code ?? "")
  )
    return error.code!;
  return LIFECYCLE_ERROR_CODE.FAILED;
}

function lifecycleError(code: string, message: string): LifecycleError {
  return { lifecycle_protocol: LIFECYCLE_PROTOCOL, ok: false, code, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
