import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

import { ensureTemporal } from "#src/lib/temporal-support";

// TanStack Start's default client entry, preceded by the Temporal polyfill where the browser
// lacks Temporal, so every module can use it from the first render. If the polyfill cannot load
// the page still hydrates: only date math breaks, instead of the whole page staying inert.
void ensureTemporal()
  .catch((cause: unknown) => console.error("Temporal polyfill could not be loaded", cause))
  .finally(() => {
    startTransition(() => {
      hydrateRoot(
        document,
        <StrictMode>
          <StartClient />
        </StrictMode>,
      );
    });
  });
