/**
 * Simplified link opener for the report editor.
 * External URLs open in a new tab; same-origin absolute paths use location.assign.
 * Mentions / Multica navigate events are stubbed out.
 */

export function openLink(href: string, _currentSlug?: string | null): void {
  if (href.startsWith("/")) {
    window.location.assign(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

/** Mention protocol links must not open as regular URLs (stubbed schema). */
export function isMentionHref(href: string | null | undefined): href is string {
  return !!href && href.startsWith("mention://");
}
