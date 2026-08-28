import type { AccessibleWorkspace } from "../login";
import { setupError } from "../errors";
import { terminalText } from "../terminal-output";

export type WorkspacePickerKey = "up" | "down" | "return" | "escape" | "quit";

export interface WorkspacePickerKeyboard {
  start(onKey: (key: WorkspacePickerKey) => void): void;
  stop(): void;
}

export function createTerminalWorkspacePicker(
  keyboard: WorkspacePickerKeyboard,
  output = process.stderr,
) {
  return (workspaces: AccessibleWorkspace[]): Promise<AccessibleWorkspace> =>
    new Promise((resolve, reject) => {
      let selectedIndex = 0;
      const lineCount = workspaces.length + 2;
      const render = (initial = false) => {
        if (!initial) output.write(`\x1b[${lineCount}A`);
        output.write("\x1b[2KChoose a Workspace:\n");
        for (const [index, workspace] of workspaces.entries())
          output.write(
            `\x1b[2K${index === selectedIndex ? "❯" : " "} ${terminalText(workspace.name)} (${terminalText(workspace.slug)})\n`,
          );
        output.write("\x1b[2KUse ↑/↓ to move, Enter to select, Esc to cancel\n");
      };
      const cleanup = () => {
        keyboard.stop();
      };
      const onKeypress = (key: WorkspacePickerKey) => {
        if (key === "up")
          selectedIndex = (selectedIndex - 1 + workspaces.length) % workspaces.length;
        else if (key === "down") selectedIndex = (selectedIndex + 1) % workspaces.length;
        else if (key === "return") {
          const selected = workspaces[selectedIndex];
          if (!selected) return;
          cleanup();
          resolve(selected);
          return;
        } else if (key === "escape" || key === "quit") {
          cleanup();
          reject(setupError("SETUP_WORKSPACE_NOT_FOUND", "Workspace selection was cancelled."));
          return;
        } else return;
        render();
      };
      keyboard.start(onKeypress);
      render(true);
    });
}
