import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LayoutStorage } from "react-resizable-panels";

import {
  NO_PANEL_LAYOUTS,
  panelLayoutStorage,
  type StoredPanelLayouts,
} from "./panel-layout-cookie";

const PanelLayoutsContext = createContext<StoredPanelLayouts>(NO_PANEL_LAYOUTS);

/** Supplies the panel layouts the server render starts from (`loadPanelLayouts`). Where none is
 * above, panels start from their default sizes. */
export function PanelLayoutProvider({
  layouts,
  children,
}: {
  layouts: StoredPanelLayouts;
  children: ReactNode;
}) {
  return <PanelLayoutsContext value={layouts}>{children}</PanelLayoutsContext>;
}

/** The `useDefaultLayout` storage for a resizable group of the conversation pages. */
export function usePanelLayoutStorage(): LayoutStorage {
  const layouts = useContext(PanelLayoutsContext);
  return useMemo(() => panelLayoutStorage(layouts), [layouts]);
}
