import { Check } from "@untitledui/icons";
import type { ComponentType, SVGProps } from "react";

import { Button } from "@/components/base/buttons/button";

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
  icon: ComponentType<SVGProps<SVGSVGElement> & { color?: string; size?: number }>;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      color="secondary"
      aria-pressed={selected}
      className={`relative h-auto flex-col items-stretch justify-start whitespace-normal rounded-xl p-4 text-left shadow-xs ${selected ? "border-brand bg-primary ring-1 ring-brand" : "hover:bg-primary_hover"}`}
      onPress={onSelect}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-lg border border-secondary bg-primary text-tertiary shadow-xs">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <span
        aria-hidden="true"
        className={`absolute top-4 right-4 flex size-5 items-center justify-center rounded-full border border-secondary ${selected ? "border-brand bg-brand-solid text-white" : "bg-primary"}`}
      >
        {selected && <Check className="size-3.5" />}
      </span>
      <span className="block text-sm font-semibold">{label}</span>
      <span className="mt-1 block text-sm leading-5 text-tertiary">{description}</span>
    </Button>
  );
}
