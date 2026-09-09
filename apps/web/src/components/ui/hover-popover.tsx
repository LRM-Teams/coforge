import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";

import { cn } from "@/lib/utils";

// Adapted from Untitled UI's base/select/popover.tsx (MIT; UNTITLED-UI-LICENSE).
// React Aria owns positioning, dismissal and focus; the delay only bridges
// pointer travel between the trigger and its interactive content.
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
        placement="bottom start"
        offset={12}
        containerPadding={12}
        onMouseEnter={cancel}
        onMouseLeave={() => delay(false)}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-24px)] origin-(--trigger-anchor-point) overflow-y-auto rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none",
          "motion-safe:data-[entering]:animate-in motion-safe:data-[entering]:fade-in motion-safe:data-[exiting]:animate-out motion-safe:data-[exiting]:fade-out",
          className,
        )}
      >
        <Dialog className="outline-none">{children}</Dialog>
      </Popover>
    </DialogTrigger>
  );
}
