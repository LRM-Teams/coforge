import { cx } from "@/utils/cx";

export function ProjectImage({
  name,
  url,
  className,
}: {
  name: string;
  url: string | null;
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
        name.trim().slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
