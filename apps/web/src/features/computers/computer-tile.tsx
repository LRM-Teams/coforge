import { ArrowUp } from "@untitledui/icons";

import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { computerIcon, type ComputerIdentity } from "./computer-identity";

/** Pixel-proportional pieces for each tile size, keyed off the default `md` (36px) shape. */
const tileSizes = {
  md: {
    tile: "size-9",
    radius: "rounded-[10px]",
    icon: "size-4",
    dot: "size-2.5",
    dotBorder: "border-2",
    dotOffset: "-right-0.5 -bottom-0.5",
    badge: "size-4",
    badgeOffset: "-top-1 -right-1",
    badgeIcon: "size-[9px]",
    loading: "size-3",
  },
  xl: {
    tile: "size-20",
    radius: "rounded-[20px]",
    icon: "size-10",
    dot: "size-5",
    dotBorder: "border-[3px]",
    dotOffset: "-right-1 -bottom-1",
    badge: "size-7",
    badgeOffset: "-top-1.5 -right-1.5",
    badgeIcon: "size-3.5",
    loading: "size-6",
  },
} as const;

/** The Computer's own face: cloud-hosted or a machine the User controls. */
export function ComputerTile({
  computer,
  online,
  updateAvailableVersion,
  upgrading = false,
  size = "md",
}: {
  computer: ComputerIdentity;
  /** Presence dot. Omit it where the panel already states the status. */
  online?: boolean;
  /** The release this Computer could move to. Omit it where nothing is waiting. */
  updateAvailableVersion?: string | null;
  /** An upgrade operation is in flight for this Computer. */
  upgrading?: boolean;
  /** `md` (36px, default) for lists and bars; `xl` (80px) for a page hero. */
  size?: "md" | "xl";
}) {
  const Icon = computerIcon(computer);
  const dims = tileSizes[size];

  return (
    <span className="relative flex shrink-0">
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center justify-center border border-secondary bg-primary text-tertiary",
          dims.tile,
          dims.radius,
        )}
      >
        <Icon className={dims.icon} />
      </span>
      {upgrading ? (
        <LoadingIndicator
          className={cn("absolute text-fg-tertiary", dims.badgeOffset, dims.loading)}
          label={m.computer_upgrade_in_progress()}
        />
      ) : (
        updateAvailableVersion && (
          <Tooltip title={m.computer_new_version({ version: updateAvailableVersion })}>
            <TooltipTrigger className={cn("absolute rounded-full", dims.badgeOffset)}>
              <span
                aria-hidden="true"
                className={cn(
                  "flex items-center justify-center rounded-full border-2 border-primary bg-fg-success-primary",
                  dims.badge,
                )}
              >
                <ArrowUp className={cn(dims.badgeIcon, "text-white")} />
              </span>
              <span className="sr-only">
                {m.computer_new_version({ version: updateAvailableVersion })}
              </span>
            </TooltipTrigger>
          </Tooltip>
        )
      )}
      {online !== undefined && (
        <StatusDot
          tone={online ? "online" : "offline"}
          label={online ? m.computer_status_online() : m.computer_status_offline()}
          className={cn("absolute border-primary", dims.dot, dims.dotBorder, dims.dotOffset)}
        />
      )}
    </span>
  );
}
