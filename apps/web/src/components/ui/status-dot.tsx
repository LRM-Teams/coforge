import { cn } from "#src/lib/utils";

/** Every presence/activity colour the app draws as a dot: Computers are online or offline;
 * Agents add what they are doing right now. */
export type StatusTone =
  | "online"
  | "working"
  | "thinking"
  | "idle"
  | "offline"
  | "error"
  | "output"
  | "unknown";

/** Presence greens/greys are the CoForge `online`/`offline` tokens (coforge-theme.css), which
 * carry a dark-mode variant; an idle Agent is "online" in the same sense as a Computer. */
export function statusToneClass(tone: StatusTone) {
  switch (tone) {
    case "online":
    case "idle":
      return "bg-online";
    case "working":
    case "thinking":
      return "bg-utility-amber-500";
    case "error":
      return "bg-error-solid";
    case "output":
      return "bg-utility-sky-500";
    default:
      return "bg-offline";
  }
}

/**
 * The one status dot for Agents and Computers. Tone picks the colour; `pulse` animates it
 * while an Agent is working or thinking. Size and placement come from `className`, so the
 * same dot serves avatar/tile corners, inline status lines and activity rows.
 *
 * Pass `label` when the dot is the only thing conveying the status (it becomes an `img`
 * with that name); leave it out when adjacent text already says it.
 */
export function StatusDot({
  tone,
  pulse = false,
  label,
  className,
}: {
  tone: StatusTone;
  pulse?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cn(
        "shrink-0 rounded-full",
        statusToneClass(tone),
        pulse && "motion-safe:animate-pulse",
        className,
      )}
    />
  );
}
