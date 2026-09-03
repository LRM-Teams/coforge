import type { LucideIcon } from "lucide-react";

/**
 * One of the kinds of Computer a Workspace can add. Both kinds read the same,
 * so the choice is one component rather than one component per kind.
 */
export function ComputerTypeOption({
  icon: Icon,
  label,
  description,
  selected,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`rounded-2xl border p-5 text-left transition-colors ${selected ? "border-brand bg-brand/5 ring-1 ring-brand" : "hover:bg-muted"}`}
      onClick={onSelect}
    >
      <span className="mb-5 flex size-14 items-center justify-center rounded-xl bg-muted">
        <Icon aria-hidden="true" className="size-7" />
      </span>
      <span className="block text-lg font-medium">{label}</span>
      <span className="mt-2 block text-sm leading-6 text-muted-foreground">{description}</span>
    </button>
  );
}
