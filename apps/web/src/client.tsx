import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

import { ensureTemporal } from "#src/lib/temporal-support";

// TanStack Start's default client entry, preceded by the Temporal polyfill where the browser
// lacks Temporal, so every module can use it from the first render.
void ensureTemporal().then(() => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
    );
  });
});
