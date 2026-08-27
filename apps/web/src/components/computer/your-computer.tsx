import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

type OperatingSystem = "macos-linux" | "windows";

const commands: Record<OperatingSystem, string> = {
  "macos-linux": "curl -fsSL https://get.coforge.dev/computer | sh",
  windows: "irm https://get.coforge.dev/computer.ps1 | iex",
};

export function YourComputerInstall() {
  const [operatingSystem, setOperatingSystem] = useState<OperatingSystem>("macos-linux");
  const [copied, setCopied] = useState(false);
  const command = commands[operatingSystem];

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  }

  return (
    <div className="space-y-6 px-6 py-8 sm:px-8">
      <div className="flex gap-2" role="tablist" aria-label={m.computer_operating_system()}>
        {(
          [
            { id: "macos-linux", label: m.computer_os_macos_linux() },
            { id: "windows", label: m.computer_os_windows() },
          ] as const
        ).map(({ id, label }) => (
          <Button
            key={id}
            type="button"
            role="tab"
            aria-selected={operatingSystem === id}
            variant="outline"
            size="sm"
            className={
              operatingSystem === id
                ? "border-brand bg-secondary text-brand hover:bg-secondary"
                : "border-border bg-secondary text-muted-foreground hover:border-brand/60 hover:bg-secondary hover:text-brand"
            }
            onClick={() => {
              setOperatingSystem(id);
              setCopied(false);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <div>
        <p className="text-sm font-medium">{m.computer_install_step()}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {m.computer_install_step_description()}
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-[#171b23] p-4 text-sm text-[#f4f6fb]">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
          <Button
            variant="secondary"
            size="icon"
            aria-label={m.computer_copy_command()}
            onClick={copyCommand}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </div>
        {copied && <p className="mt-2 text-xs text-success">{m.computer_command_copied()}</p>}
      </div>
      <div className="rounded-xl bg-muted p-4 text-sm leading-6 text-muted-foreground">
        {m.computer_install_note()}
      </div>
    </div>
  );
}
