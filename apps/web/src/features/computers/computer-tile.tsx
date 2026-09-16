import { ArrowUp } from "@untitledui/icons";

import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { computerIcon, type ComputerIdentity } from "./computer-identity";

/** The Computer's own face: cloud-hosted or a machine the User controls. */
export function ComputerTile({
  computer,
  online,
  updateAvailableVersion,
  upgrading = false,
}: {
  computer: ComputerIdentity;
  /** Presence dot. Omit it where the panel already states the status. */
  online?: boolean;
  /** The release this Computer could move to. Omit it where nothing is waiting. */
  updateAvailableVersion?: string | null;
  /** An upgrade operation is in flight for this Computer. */
  upgrading?: boolean;
}) {
  const Icon = computerIcon(computer);

  return (
    <span className="relative flex shrink-0">
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-[10px] border border-secondary bg-primary text-tertiary"
      >
        <Icon className="size-4" />
      </span>
      {upgrading ? (
        <span className="absolute -top-1 -right-1 flex">
          <LoadingIndicator
            className="size-3 text-fg-brand-primary"
            label={m.computer_upgrade_in_progress()}
          />
        </span>
      ) : (
        updateAvailableVersion && (
          <Tooltip title={m.computer_new_version({ version: updateAvailableVersion })}>
            <TooltipTrigger className="absolute -top-1 -right-1 rounded-full">
              <span
                aria-hidden="true"
                className="flex size-4 items-center justify-center rounded-full border-2 border-primary bg-fg-brand-primary"
              >
                <ArrowUp className="size-[9px] text-white" />
              </span>
              <span className="sr-only">
                {m.computer_new_version({ version: updateAvailableVersion })}
              </span>
            </TooltipTrigger>
          </Tooltip>
        )
      )}
      {online !== undefined && (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-primary",
              online ? "bg-online" : "bg-offline",
            )}
          />
          <span className="sr-only">
            {online ? m.computer_status_online() : m.computer_status_offline()}
          </span>
        </>
      )}
    </span>
  );
}
