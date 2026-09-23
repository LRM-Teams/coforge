import { useEffect, useEffectEvent } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * Opening a chat the viewer had closed brings it back to their list, like Slack's closed
 * conversations. The page reports the viewer's `hidden` flag; this clears it and refreshes the
 * sidebar. It runs only on a mounted page: hover preloads fetch the same data without mounting it,
 * so they never reopen anything.
 */
export function useReopenClosedConversation(
  conversationId: string,
  hidden: boolean,
  reopen: () => Promise<unknown>,
) {
  const router = useRouter();
  const reopenNow = useEffectEvent(async () => {
    try {
      await reopen();
      await router.invalidate({ sync: true });
    } catch (error) {
      // The chat stays readable; only its sidebar row is still missing until the next visit.
      console.warn("[coforge] closed conversation did not reopen", error);
    }
  });
  useEffect(() => {
    if (hidden) void reopenNow();
  }, [conversationId, hidden]);
}
