import { terminalText } from "../terminal-output";
import type { SetupResult } from "../setup/computer-setup";

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
        daemon_started: true,
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
  writeLine("Daemon:                started");
}
