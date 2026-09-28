/** How many lines of a long message body stay visible while it is collapsed. Long enough that an
 * ordinary message is never touched, short enough that one wall of text cannot take over the
 * viewport. */
const COLLAPSED_MESSAGE_LINES = 13;

/** The collapsed height as CSS: thirteen lines of the message text's line height, which follows
 * both Settings → Text size and Settings → Message font size (`message-markdown.css`). */
export const COLLAPSED_MESSAGE_MAX_HEIGHT = `calc(${COLLAPSED_MESSAGE_LINES} * var(--text-md--line-height))`;

/** The collapsed height in px for the body's computed line height. */
export function collapsedMessageHeightPx(lineHeightPx: number): number {
  return COLLAPSED_MESSAGE_LINES * lineHeightPx;
}

/** Whether a body of this full (scroll) height needs collapsing. The 1px slack absorbs sub-pixel
 * rounding of a body that is exactly thirteen lines tall. */
export function overflowsCollapsedMessage(scrollHeightPx: number, lineHeightPx: number): boolean {
  return scrollHeightPx > collapsedMessageHeightPx(lineHeightPx) + 1;
}
