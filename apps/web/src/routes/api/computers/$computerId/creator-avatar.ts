import { createFileRoute } from "@tanstack/react-router";
import { handleComputerCreatorAvatar } from "../../../../server/computers/computer-creator-avatar.server";

export const Route = createFileRoute("/api/computers/$computerId/creator-avatar")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleComputerCreatorAvatar(request, params.computerId),
    },
  },
});
