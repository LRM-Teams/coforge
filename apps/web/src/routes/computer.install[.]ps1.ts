import { createFileRoute } from "@tanstack/react-router";

import { installPs1Handler } from "@/server/install/install-script.server";

export const Route = createFileRoute("/computer/install.ps1")({
  server: { handlers: { GET: installPs1Handler } },
});
