import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requestIsFromPhone } from "#src/lib/assumed-viewport";

/**
 * Whether the render should assume a phone (`AssumedViewportProvider`): from the request on the
 * server. In the browser it says no, and no render reads it: the answer that hydration needs is
 * the one the server's page carries, and later renders read the real viewport.
 */
export const loadAssumedPhone = createIsomorphicFn()
  .server(() => requestIsFromPhone(getRequest().headers))
  .client(() => false);
