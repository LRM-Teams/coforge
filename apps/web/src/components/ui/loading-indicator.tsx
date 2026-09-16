import { ProgressBar } from "react-aria-components";

import { cn } from "@/lib/utils";

/**
 * The product's one inline spinner: work is in flight, with no idea how far along it is.
 *
 * React Aria's `ProgressBar` with `isIndeterminate` is the framework's own recipe for a circular
 * spinner, so `role="progressbar"` and the accessible name come from the framework rather than
 * from hand-written ARIA. The SVG geometry matches the spinner Untitled UI's `Button` draws while
 * it is pending, so the motion is the same wherever it appears.
 *
 * Not the official Untitled UI `application/loading-indicator`: that one is the page-level block -
 * a 32-64px spinner in a centered flex column with a visible caption below it, and no `className`.
 * This is the inline one, sized and colored by the caller.
 *
 * @see https://react-spectrum.adobe.com/react-aria/ProgressBar.html
 */
export function LoadingIndicator({
  label,
  className,
}: {
  /** What is in flight. Becomes the spinner's accessible name, so it is never optional. */
  label: string;
  /** Sizing and color, as with any icon. */
  className?: string;
}) {
  return (
    <ProgressBar isIndeterminate aria-label={label} className="inline-flex shrink-0">
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
    </ProgressBar>
  );
}
