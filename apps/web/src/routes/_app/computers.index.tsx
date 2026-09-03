import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/computers/")({
  loader: async ({ parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise;
    const first = loaderData?.computers[0];
    if (first) {
      throw redirect({ to: "/computers/$computerId", params: { computerId: first.id } });
    }
  },
  // With no Computers the layout carries the empty state; there is nothing to
  // select and nothing to detail.
  component: () => null,
});
