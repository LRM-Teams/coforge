import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BrowserRealtimeProvider,
  useRealtimeSubscription,
} from "@/features/realtime/browser-realtime";

function Subscriber() {
  useRealtimeSubscription({ channel: "agent:activity:workspace", onPublication: () => {} });
  return <p>subscribed</p>;
}

test("a subscription outside BrowserRealtimeProvider fails instead of never subscribing", () => {
  expect(() => renderToStaticMarkup(<Subscriber />)).toThrow("inside BrowserRealtimeProvider");
});

test("a subscription inside BrowserRealtimeProvider renders", () => {
  const markup = renderToStaticMarkup(
    <BrowserRealtimeProvider workspaceId="workspace" getConnectionToken={async () => "token"}>
      <Subscriber />
    </BrowserRealtimeProvider>,
  );
  expect(markup).toContain("subscribed");
});
