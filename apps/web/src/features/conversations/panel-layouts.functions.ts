import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { NO_PANEL_LAYOUTS, storedPanelLayouts } from "./panel-layout-cookie";

/**
 * The panel layouts to start a render from. The server render reads them from the request's
 * cookies; a browser has nothing to carry, since its storage reads its own cookie live
 * (`panelLayoutStorage`).
 */
export const loadPanelLayouts = createIsomorphicFn()
  .server(() => storedPanelLayouts(getRequest().headers.get("cookie") ?? undefined))
  .client(() => NO_PANEL_LAYOUTS);
