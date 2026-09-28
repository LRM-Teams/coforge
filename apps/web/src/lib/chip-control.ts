import type { KeyboardEvent } from "react";

/**
 * What makes a body chip (an Agent mention, a task reference) a keyboard- and pointer-accessible
 * control that runs `open`; nothing when there is nothing to open.
 */
export function chipControl(open: (() => void) | undefined) {
  return (
    open && {
      role: "button",
      tabIndex: 0,
      onClick: open,
      onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      },
    }
  );
}
