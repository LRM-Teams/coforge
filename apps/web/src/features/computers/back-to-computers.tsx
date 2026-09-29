import { createContext, useContext } from "react";
import { ChevronLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

/**
 * Lets the selected Computer put the "back to the list" control in its own
 * header band, the way the conversation panels do. Below `md` only one panel
 * fits, so the layout owns which one is showing and shares the way back.
 */
export const BackToComputersContext = createContext<(() => void) | undefined>(undefined);

/** Returns to the Computer list on small screens, where only one panel fits. */
export function BackToComputers() {
  const back = useContext(BackToComputersContext);
  if (!back) {
    return null;
  }

  return (
    <ButtonUtility
      color="tertiary"
      size="sm"
      onClick={back}
      aria-label={m.computer_back_to_list()}
      className="-ml-2 size-11 shrink-0 md:hidden"
      icon={ChevronLeft}
    />
  );
}
