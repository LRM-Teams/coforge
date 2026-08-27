import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
  return <AppShell page="settings" />;
}
