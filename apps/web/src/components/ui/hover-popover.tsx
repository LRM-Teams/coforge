import { useContext, type ReactNode } from "react";
import {
  Button,
  OverlayTriggerStateContext,
  Popover,
  PreviewTrigger,
  type ButtonProps,
} from "react-aria-components";

import { cn } from "#src/lib/utils";

// Untitled UI has no hover-triggered popover, but React Aria ships this exact interaction:
// PreviewTrigger "displays a non-modal popover on hover, focus, or long press. Unlike a
// tooltip, the popover may contain interactive content."
// (https://react-aria.adobe.com/PreviewTrigger)
//
// It owns what a peek has to get right and this file used to hand-roll: the warm-up and
// cool-down delays, the safe area that keeps the peek open while the pointer travels
// diagonally into it, opening on keyboard focus with Tab moving into the content and Escape
// closing it and restoring focus, long press on touch with focus moved in so a screen reader's
// virtual cursor follows, and the aria-haspopup/aria-expanded/aria-controls/aria-describedby
// wiring on the trigger.
//
// It never binds a press, so the trigger keeps its own: the Agent avatar opens the profile
// panel on a press. That press also closes the peek, which would otherwise stay over the page the
// press just changed until the pointer leaves.
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
  /** The trigger's own action for a press (pointer or keyboard); the press also closes the peek. */
  onPress?: () => void;
  working?: boolean;
}) {
  return (
    <PreviewTrigger
      // React Aria defaults to 600ms, tuned for links in running prose. These triggers are
      // badges and avatars the pointer lands on deliberately, so the peek stays quicker.
      delay={250}
      closeDelay={200}
      onOpenChange={(isOpen) => {
        if (isOpen) onOpen?.();
      }}
    >
      <PreviewTriggerButton
        aria-label={label}
        data-working={working}
        className={triggerClassName}
        onPress={onPress}
      >
        {trigger}
      </PreviewTriggerButton>
      <Popover
        placement="bottom start"
        offset={12}
        containerPadding={12}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-24px)] origin-(--trigger-anchor-point) overflow-y-auto rounded-xl border border-secondary bg-primary text-primary shadow-lg outline-none",
          "motion-safe:data-[entering]:animate-in motion-safe:data-[entering]:fade-in motion-safe:data-[exiting]:animate-out motion-safe:data-[exiting]:fade-out",
          className,
        )}
      >
        {children}
      </Popover>
    </PreviewTrigger>
  );
}

/** The trigger, inside `PreviewTrigger` so it can reach the peek's open state: `PreviewTrigger`
 * provides it through `OverlayTriggerStateContext`, the context React Aria's own overlay triggers
 * share with their content. */
function PreviewTriggerButton({ onPress, ...props }: ButtonProps) {
  const closePreview = useClosePreview();
  return (
    <Button
      {...props}
      onPress={
        onPress &&
        ((event) => {
          closePreview();
          onPress(event);
        })
      }
    />
  );
}

/** Closes the peek the calling content sits in; for an action inside the popover that moves the
 * reader somewhere else (the Agent card's "Recent activity" link opens the profile panel). */
export function useClosePreview(): () => void {
  const preview = useContext(OverlayTriggerStateContext);
  return () => preview?.close();
}
