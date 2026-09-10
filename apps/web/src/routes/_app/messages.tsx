import { Outlet, createFileRoute } from "@tanstack/react-router";

import { MessagesPending } from "@/features/conversations/conversation-pending";
import { PageLoadError } from "@/features/errors/page-load-error";

export const Route = createFileRoute("/_app/messages")({
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: MessagesPending,
  errorComponent: PageLoadError,
  component: MessagesPage,
});

function MessagesPage() {
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <Outlet />
    </main>
  );
}
