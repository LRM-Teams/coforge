import { ProgressBar } from "react-aria-components";

import { cn } from "@/lib/utils";

/**
 * The product's one inline spinner: work is in flight, with no idea how far along it is.
 *
 * Two libraries, one job each. daisyUI draws it - its `loading` component is plain CSS with no
 * runtime dependency, Tailwind-native, and registered in `styles.css` with `include: loading`,
 * `themes: false` and a `d-` prefix, so nothing else of daisyUI's reaches the bundle and CoForge
 * colour tokens stay authoritative. React Aria's `ProgressBar` with `isIndeterminate` gives it
 * meaning: `role="progressbar"` and the accessible name come from the framework rather than from
 * hand-written ARIA.
 *
 * daisyUI's spinner paints in `currentColor` and Tailwind's `size-*` overrides its default size,
 * so `className` is the whole styling surface. Pass a colour token that reads on both grounds.
 *
 * Use this one inline - beside text, inside a badge, in a button-sized slot. Untitled UI's
 * `application/loading-indicator` is the other one: a page-level block, 32-64px, with a visible
 * caption below it and no `className`, for a whole view that is still loading.
 *
 * @see https://react-spectrum.adobe.com/react-aria/ProgressBar.html
 * @see https://daisyui.com/components/loading/
 */
export function LoadingIndicator({
  label,
  className,
}: {
  /** What is in flight. Becomes the spinner's accessible name, so it is never optional. */
  label: string;
  /** Size and colour, as with any icon. */
  className?: string;
}) {
  return (
    <ProgressBar
      isIndeterminate
      aria-label={label}
      className={cn("inline-flex shrink-0", className)}
    >
      <span aria-hidden="true" className="d-loading d-loading-spinner size-full" />
    </ProgressBar>
  );
}
