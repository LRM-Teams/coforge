import type { ReactNode } from "react";

import { cx } from "#src/utils/cx";

/** A Project's uploaded icon, or `fallback` (its first letter by default) when it has none. */
export function ProjectImage({
  name,
  url,
  fallback,
  className,
}: {
  name: string;
  url: string | null;
  fallback?: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary font-medium text-tertiary",
        className,
      )}
    >
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        (fallback ?? name.trim().slice(0, 1).toUpperCase())
      )}
    </span>
  );
}
