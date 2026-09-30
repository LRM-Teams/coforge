import { Command, CommanderError } from "commander";

import { COFORGE_COMPUTER_VERSION } from "#src/version";
import {
  LIFECYCLE_ERROR_CODE,
  LIFECYCLE_EXIT_CODE,
  LIFECYCLE_PROTOCOL,
  type LifecycleError,
  type LifecycleStatus,
} from "./installer-contract";
import {
  createSupervisorStatusReader,
  resolveSupervisorPaths,
  type SupervisorStatusReader,
} from "./supervisor-status";

/**
 * `coforge-computer __lifecycle <command>`: the versioned JSON surface through which the
 * separately released installer reads this Computer. Every call prints exactly one JSON object on
 * stdout and nothing else, so the installer never parses human text; the exit status is one of
 * `LIFECYCLE_EXIT_CODE`. Both commands only read: the installer also probes a candidate binary
 * that has never run.
 */
export async function runLifecycleCommand(args: readonly string[]): Promise<number> {
  return runCommand(args, createSupervisorStatusReader(resolveSupervisorPaths()));
}

async function runCommand(
  args: readonly string[],
  reader: SupervisorStatusReader,
): Promise<number> {
  const print = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
  // A machine interface: no help or version output, and every Commander failure is a usage error.
  const program = new Command()
    .name("coforge-computer __lifecycle")
    .helpOption(false)
    .helpCommand(false)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.command("protocol").action(() => {
    print({ lifecycle_protocol: LIFECYCLE_PROTOCOL, version: COFORGE_COMPUTER_VERSION });
  });
  program.command("status").action(async () => {
    const status = await reader.status();
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
      problems: status.problems.map(({ code, bindingId, message }) => ({
        code,
        ...(bindingId ? { binding_id: bindingId } : {}),
        message,
      })),
    } satisfies LifecycleStatus);
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
        LIFECYCLE_ERROR_CODE.FAILED,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return LIFECYCLE_EXIT_CODE.FAILED;
  }
}

function lifecycleError(code: string, message: string): LifecycleError {
  return { lifecycle_protocol: LIFECYCLE_PROTOCOL, ok: false, code, message };
}
