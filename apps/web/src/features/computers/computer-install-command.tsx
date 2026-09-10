import { useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { installCommands, loginCommand, setupCommand } from "@/features/install/install-commands";
import { m } from "@/paraglide/messages";

type OperatingSystem = "macos-linux" | "windows";

/** The three commands that connect a machine: install, rooted at the deployment the User is
 * signed in to rather than at a fixed host; sign in, which `setup` cannot run without because
 * registering a Computer needs an account to register against; and join, which binds it to the
 * current Workspace. They stay separate commands rather than one auto-chained script so that
 * joining a second Workspace from the same machine later has an equally natural, explicit
 * expression - and so a re-run of any single step is obvious. */
export function ComputerInstallCommand({
  installOrigin,
  workspaceSlug,
}: {
  installOrigin: string;
  workspaceSlug: string | null;
}) {
  const [operatingSystem, setOperatingSystem] = useState<OperatingSystem>("macos-linux");
  const [installCopied, setInstallCopied] = useState(false);
  const [loginCopied, setLoginCopied] = useState(false);
  const [setupCopied, setSetupCopied] = useState(false);
  const commands = installCommands(installOrigin);
  const command = operatingSystem === "windows" ? commands.windows : commands.posix;
  const signInCommand = loginCommand();
  const joinCommand = workspaceSlug ? setupCommand(workspaceSlug) : null;

  async function copyInstallCommand() {
    await navigator.clipboard.writeText(command);
    setInstallCopied(true);
  }

  async function copyLoginCommand() {
    await navigator.clipboard.writeText(signInCommand);
    setLoginCopied(true);
  }

  async function copySetupCommand() {
    if (!joinCommand) return;
    await navigator.clipboard.writeText(joinCommand);
    setSetupCopied(true);
  }

  return (
    <div className="space-y-6 px-6 py-8 sm:px-8">
      <div className="flex gap-2" role="group" aria-label={m.computer_operating_system()}>
        {(
          [
            { id: "macos-linux", label: m.computer_os_macos_linux() },
            { id: "windows", label: m.computer_os_windows() },
          ] as const
        ).map(({ id, label }) => (
          <Button
            key={id}
            type="button"
            aria-pressed={operatingSystem === id}
            color="secondary"
            size="sm"
            className={
              operatingSystem === id
                ? "border-brand bg-secondary text-brand-secondary hover:bg-secondary"
                : "border-secondary bg-secondary text-tertiary hover:border-brand/60 hover:bg-secondary hover:text-brand-secondary"
            }
            onPress={() => {
              setOperatingSystem(id);
              setInstallCopied(false);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <div>
        <p className="text-sm font-medium">{m.computer_install_step()}</p>
        <p className="mt-1 text-sm text-tertiary">{m.computer_install_step_description()}</p>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-terminal p-4 text-sm text-terminal-fg">
          <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{command}</code>
          <ButtonUtility
            icon={installCopied ? Check : Copy}
            size="sm"
            color="secondary"
            aria-label={m.computer_copy_command()}
            onClick={copyInstallCommand}
          />
        </div>
        {installCopied && (
          <p className="mt-2 text-xs text-success-primary">{m.computer_command_copied()}</p>
        )}
      </div>
      <div>
        <p className="text-sm font-medium">{m.computer_login_step()}</p>
        <p className="mt-1 text-sm text-tertiary">{m.computer_login_step_description()}</p>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-terminal p-4 text-sm text-terminal-fg">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{signInCommand}</code>
          <ButtonUtility
            icon={loginCopied ? Check : Copy}
            size="sm"
            color="secondary"
            aria-label={m.computer_copy_login_command()}
            onClick={copyLoginCommand}
          />
        </div>
        {loginCopied && (
          <p className="mt-2 text-xs text-success-primary">{m.computer_login_command_copied()}</p>
        )}
      </div>
      {joinCommand && (
        <div>
          <p className="text-sm font-medium">{m.computer_setup_step()}</p>
          <p className="mt-1 text-sm text-tertiary">
            {m.computer_setup_step_description({
              workspace: workspaceSlug ?? "",
            })}
          </p>
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-terminal p-4 text-sm text-terminal-fg">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{joinCommand}</code>
            <ButtonUtility
              icon={setupCopied ? Check : Copy}
              size="sm"
              color="secondary"
              aria-label={m.computer_copy_setup_command()}
              onClick={copySetupCommand}
            />
          </div>
          {setupCopied && (
            <p className="mt-2 text-xs text-success-primary">{m.computer_setup_command_copied()}</p>
          )}
        </div>
      )}
      <div className="rounded-xl bg-secondary p-4 text-sm leading-6 text-tertiary">
        {m.computer_install_note()}
      </div>
    </div>
  );
}
