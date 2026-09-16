import { cn } from "@/lib/utils";

/**
 * The spinner Untitled UI's Button draws while it is pending, as a standalone primitive for the
 * places that need the same motion without a button around it. The official Button keeps its own
 * copy: `components/base` is unmodified upstream source, so this adapts callers rather than it.
 *
 * Decorative by default; give a `label` wherever the spinner is the only thing announcing that
 * work is in flight.
 */
export function LoadingIndicator({
  className,
  label,
}: {
  /** Sizing and color come from the caller, as with any icon. */
  className?: string;
  label?: string;
}) {
  return (
    <span className="inline-flex shrink-0" role={label ? "status" : undefined}>
      <svg fill="none" viewBox="0 0 20 20" aria-hidden="true" className={cn("size-4", className)}>
        <circle className="stroke-current opacity-30" cx="10" cy="10" r="8" strokeWidth="2" />
        <circle
          className="origin-center animate-spin stroke-current"
          cx="10"
          cy="10"
          r="8"
          strokeWidth="2"
          strokeDasharray="12.5 50"
          strokeLinecap="round"
        />
      </svg>
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}
