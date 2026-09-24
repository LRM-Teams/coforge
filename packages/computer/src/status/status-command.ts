import { CliError } from "#src/errors";
import { collectComputerStatus } from "./collect-status";
import { renderStatusHuman, renderStatusJson } from "./render-status";
import type { StatusPorts } from "./types";

export interface StatusCommand {
  run(options: { json: boolean }): Promise<void>;
}

/** `status` never starts, stops, or configures anything - `collectComputerStatus` only reads
 * through the injected ports. The report itself is the product: an unhealthy machine still
 * exits 0. The lone exception is a corrupt or unreadable `active.json`, which every other
 * section is reported relative to; that throws a `CliError` so the shared error path (which
 * already knows how to print both the human and `--json` shapes) reports exit code 1. */
export function createStatusCommand(
  io: { stdout: (line: string) => void },
  ports: StatusPorts,
): StatusCommand {
  return {
    async run(options) {
      const report = await collectComputerStatus(ports);
      if (!report.install.readable) {
        throw new CliError(
          "STATUS_INSTALL_UNREADABLE",
          report.install.error,
          "Reinstall CoForge Computer, or check permissions on ~/.coforge/computer/install/active.json.",
        );
      }
      if (options.json) {
        io.stdout(renderStatusJson(report));
      } else {
        for (const line of renderStatusHuman(report)) io.stdout(line);
      }
    },
  };
}
