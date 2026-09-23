import { createFileRoute } from "@tanstack/react-router";
import { fileDeliveryStatus } from "@/server/files/file-delivery.server";
import { publicImageDeliveryStatus } from "@/server/files/public-image-delivery.server";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: () =>
        new Response("ok", {
          // Operators can see whether signed CDN delivery loaded without host access. The value
          // is a state or an error class name, never configuration or secret material.
          headers: {
            "X-CoForge-File-Delivery": describe(fileDeliveryStatus()),
            "X-CoForge-Image-Delivery": describe(publicImageDeliveryStatus()),
          },
        }),
    },
  },
});

function describe(status: { state: string; errorType?: string }) {
  return status.state === "error" ? `error:${status.errorType}` : status.state;
}
