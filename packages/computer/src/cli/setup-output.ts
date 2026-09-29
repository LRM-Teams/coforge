import { terminalText } from "#src/terminal-output";
import type { SetupResult } from "#src/setup/computer-setup";

export function writeSetupResult(
  writeLine: (line: string) => void,
  result: SetupResult,
  json: boolean,
): void {
  if (json) {
    writeLine(
      JSON.stringify({
        ok: true,
        workspace: result.workspace,
        config_path: result.configPath,
        server_registration_created: true,
        daemon_started: !result.daemonStillStarting,
        ...(result.daemonStillStarting ? { daemon_still_starting: true } : {}),
      }),
    );
    return;
  }
  writeLine("CoForge Computer setup complete");
  writeLine(
    `Workspace:             ${terminalText(result.workspace.name)} (${terminalText(result.workspace.slug)})`,
  );
  writeLine(`Configuration saved:   ${terminalText(result.configPath)}`);
  writeLine("Computer:              registered");
  writeLine(
    result.daemonStillStarting
      ? "Daemon:                still starting; run 'coforge-computer status' to follow it"
      : "Daemon:                started",
  );
}
