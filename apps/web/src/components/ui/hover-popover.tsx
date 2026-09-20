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
  onPress,
  working,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  className?: string;
  children: ReactNode;
  onOpen?: () => void;
  /** Primary action for a press (pointer or keyboard). Absent, the press toggles the peek
   * itself, so touch and keyboard users — who cannot hover — can still reach the content. */
  onPress?: () => void;
  working?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
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

  // The peek has one owner: this component. A press with a primary action runs it and ends
  // the peek — the action already gives the user the full view. A press without one toggles
  // the peek, which is how a touch or keyboard user, who never hovers, reaches and dismisses
  // the content at all.
  //
  // DialogTrigger toggles the popover on every trigger press of its own accord, and reports
  // it through `onOpenChange`. Accepting that `true` would race this handler, so the handler
  // below decides every open and `onOpenChange` is honoured only when it closes (Escape, a
  // press outside the trigger, or DialogTrigger's own toggle-back).
  function onTriggerPress() {
    cancel();
    if (onPress) {
      change(false);
      onPress();
      return;
    }
    change(!open);
  }

  // `isNonModal` also turns off React Aria's own dismiss-on-outside-press, so a peek opened
  // by a press would survive every press elsewhere on the page. Close it here instead.
  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      change(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
    // Re-registering on every `open` change keeps `change` reading current state.
  }, [open]);

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) change(false);
      }}
    >
      <Button
        ref={triggerRef}
        aria-label={label}
        data-working={working}
        className={triggerClassName}
        onHoverStart={() => delay(true)}
        onHoverEnd={() => delay(false)}
        onPress={onTriggerPress}
      >
        {trigger}
      </Button>
      <Popover
        ref={popoverRef}
        isNonModal
        // The trigger sits outside the popover element, so without this React Aria counts
        // pressing it as an interaction outside the peek and closes the peek before the press
        // is delivered. DialogTrigger's toggle then reopened it, and the peek could never be
        // pressed shut — the peek a touch user was stuck with, touch having no hover to end it.
        shouldCloseOnInteractOutside={(element) => !triggerRef.current?.contains(element)}
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
