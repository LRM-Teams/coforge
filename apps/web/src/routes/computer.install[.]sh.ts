import { createFileRoute } from "@tanstack/react-router";

import { installShHandler } from "@/server/install/install-script.server";

export const Route = createFileRoute("/computer/install.sh")({
  server: { handlers: { GET: () => installShHandler() } },
});
