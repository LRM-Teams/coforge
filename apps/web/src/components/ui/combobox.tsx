import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronsUpDownIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
) {
  return <ComboboxPrimitive.Root {...props} />;
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "flex h-10 w-full items-center rounded-md border bg-background px-3 text-left text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.Icon className="ml-auto text-muted-foreground">
        <ChevronsUpDownIcon aria-hidden="true" className="size-4" />
      </ComboboxPrimitive.Icon>
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxValue(props: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value {...props} />;
}

function ComboboxContent({
  className,
  searchLabel,
  searchPlaceholder,
  emptyLabel,
  children,
  ...props
}: Omit<ComboboxPrimitive.Popup.Props, "children"> & {
  searchLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  children: ComboboxPrimitive.List.Props["children"];
}) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align="start"
        className="isolate z-50 outline-none"
        sideOffset={4}
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "w-(--anchor-width) min-w-64 origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          <div className="flex items-center gap-2 border-b px-3">
            <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <ComboboxPrimitive.Input
              aria-label={searchLabel}
              placeholder={searchPlaceholder}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ComboboxPrimitive.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </ComboboxPrimitive.Empty>
          <ComboboxPrimitive.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto p-1">
            {children}
          </ComboboxPrimitive.List>
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "grid cursor-default grid-cols-[1rem_1fr] items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <ComboboxPrimitive.ItemIndicator className="col-start-1">
        <CheckIcon aria-hidden="true" className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
      <span className="col-start-2 truncate">{children}</span>
    </ComboboxPrimitive.Item>
  );
}

export { Combobox, ComboboxContent, ComboboxItem, ComboboxTrigger, ComboboxValue };
