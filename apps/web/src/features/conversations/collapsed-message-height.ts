/** Collapsed height of a long message body, in rem: 13 lines of the body's 1.5rem line-height. Long
 * enough that an ordinary message is never touched, short enough that one wall of text cannot take
 * over the viewport. It is rem so it scales with Settings → Text size along with the text itself. */
export const COLLAPSED_MESSAGE_MAX_HEIGHT_REM = 13 * 1.5;

/** The collapsed height in px for the given root font size (the value Settings → Text size sets). */
export function collapsedMessageHeightPx(rootFontSizePx: number): number {
  return COLLAPSED_MESSAGE_MAX_HEIGHT_REM * rootFontSizePx;
}

/** Whether a body of this full (scroll) height needs collapsing. The 1px slack absorbs sub-pixel
 * rounding of a body that is exactly thirteen lines tall. */
export function overflowsCollapsedMessage(scrollHeightPx: number, rootFontSizePx: number): boolean {
  return scrollHeightPx > collapsedMessageHeightPx(rootFontSizePx) + 1;
}
