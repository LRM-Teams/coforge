/**
 * The workspace file pane's image branch, kept out of the component so the rules that govern it are
 * testable on their own: only `image/*` is shown as an image, and a read result becomes a URL in
 * exactly one place.
 */

/** The data URL the image renderer is handed, or `null` when this read result is not an image the
 * pane should render — everything else goes to the text viewer, including a result that names a
 * media type but carries no bytes (an `<img>` over nothing would render as a broken image). */
export function workspaceImageSource(result: {
  contentType: string;
  contentBase64: string;
}): string | null {
  if (!result.contentType.startsWith("image/") || result.contentBase64 === "") return null;
  return `data:${result.contentType};base64,${result.contentBase64}`;
}
