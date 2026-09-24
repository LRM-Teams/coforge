import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { readLastSearch } from "./search-memory";

/** Asks an open search page to put the caret back in its box. */
export const SEARCH_FOCUS_EVENT = "coforge:search-focus";

function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform;
  return /Mac|iPhone|iPad|iPod|macOS|iOS/i.test(platform);
}

/** Cmd+K on Apple platforms, Ctrl+K elsewhere; no other modifier. */
function isSearchShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) return false;
  return isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The shortcut as the search box shows it; `undefined` until the platform is known. */
export function useSearchShortcutLabel(): string | undefined {
  // Read after mount: the server render cannot know the viewer's platform.
  const [label, setLabel] = useState<string>();
  useEffect(() => setLabel(isApplePlatform() ? "⌘K" : "Ctrl+K"), []);
  return label;
}

/**
 * Cmd/Ctrl+K from anywhere in the app, even while typing: on the search page it returns the caret
 * to the box, text selected; elsewhere it opens search with the viewer's last search in this
 * Workspace. The rail's Search entry opens a fresh search instead.
 */
export function useSearchShortcut(workspaceId: string | undefined, userId: string) {
  const router = useRouter();
  useEffect(() => {
    if (!workspaceId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      if (router.state.location.pathname === "/search") {
        document.dispatchEvent(new Event(SEARCH_FOCUS_EVENT));
        return;
      }
      void router.navigate({ to: "/search", search: readLastSearch(workspaceId, userId) });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspaceId, userId, router]);
}
