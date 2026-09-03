import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { computerIcon, type ComputerIdentity } from "./computer-identity";

/** The Computer's own face: cloud or local, and which platform when local. */
export function ComputerTile({
  computer,
  online,
}: {
  computer: ComputerIdentity;
  /** Presence dot. Omit it where the panel already states the status. */
  online?: boolean;
}) {
  const Icon = computerIcon(computer);

  return (
    <span className="relative flex shrink-0">
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-[10px] border bg-background text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      {online !== undefined && (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card",
              online ? "bg-success" : "bg-offline",
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
