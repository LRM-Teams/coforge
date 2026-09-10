import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";

import { cn } from "@/lib/utils";

// Untitled UI has no hover-triggered popover; this composes React Aria's own
// DialogTrigger + Popover primitives (the same building blocks Untitled's
// official components use internally).
//
// `isNonModal` is load-bearing: without it, React Aria's default Popover
// renders a full-screen modal underlay that steals pointer events from
// everything behind it, including the trigger itself. That underlay caused
// the runtime-usage popover to flicker forever (open -> underlay covers
// trigger -> onHoverEnd fires -> close -> onHoverStart fires again -> loop).
// `isNonModal` removes the underlay so hover events reach the trigger and
// the popover content normally.
export function HoverPopover({
  label,
  trigger,
  triggerClassName,
  className,
  children,
  onOpen,
  working,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  className?: string;
  children: ReactNode;
  onOpen?: () => void;
  working?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function cancel() {
    clearTimeout(timer.current);
  }
  useEffect(() => cancel, []);

  function change(next: boolean) {
    cancel();
    setOpen(next);
    if (next && !open) onOpen?.();
  }

  function delay(next: boolean) {
    cancel();
    timer.current = setTimeout(() => change(next), next ? 250 : 200);
  }

  return (
    <DialogTrigger isOpen={open} onOpenChange={change}>
      <Button
        aria-label={label}
        data-working={working}
        className={triggerClassName}
        onHoverStart={() => delay(true)}
        onHoverEnd={() => delay(false)}
      >
        {trigger}
      </Button>
      <Popover
        isNonModal
        placement="bottom start"
        offset={12}
        containerPadding={12}
        onMouseEnter={cancel}
        onMouseLeave={() => delay(false)}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-24px)] origin-(--trigger-anchor-point) overflow-y-auto rounded-xl border border-secondary bg-primary text-primary shadow-lg outline-none",
          "motion-safe:data-[entering]:animate-in motion-safe:data-[entering]:fade-in motion-safe:data-[exiting]:animate-out motion-safe:data-[exiting]:fade-out",
          className,
        )}
      >
        <Dialog className="outline-none">{children}</Dialog>
      </Popover>
    </DialogTrigger>
  );
}
