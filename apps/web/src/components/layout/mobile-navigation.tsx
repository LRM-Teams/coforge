import { createContext, useContext } from "react";
import { LayoutLeft as PanelLeft } from "@untitledui/icons";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export const MobileNavigationContext = createContext<{
  open: boolean;
  toggle: () => void;
} | null>(null);

export function MobileNavigationButton() {
  const navigation = useContext(MobileNavigationContext);
  if (!navigation) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="-ml-2 size-11 shrink-0 md:hidden"
      aria-label={m.controls_show_sidebar()}
      aria-expanded={navigation.open}
      aria-controls="app-sidebar"
      onClick={navigation.toggle}
    >
      <PanelLeft aria-hidden="true" />
    </Button>
  );
}
