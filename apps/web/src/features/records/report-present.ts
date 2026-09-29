/** Move one template page left or right and stop at the ends. */
export function stepReportPage(index: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  const next = index + direction;
  if (next < 0) return 0;
  if (next >= count) return count - 1;
  return next;
}

const IMAGE_ZOOM_MIN = 0.5;
const IMAGE_ZOOM_MAX = 4;
const IMAGE_ZOOM_FACTOR = 1.25;

/** Scale an opened report image. 1 is fit-to-view; the scale stays between 0.5 and 4. */
export function scaleImageZoom(scale: number, direction: "in" | "out"): number {
  const next = direction === "in" ? scale * IMAGE_ZOOM_FACTOR : scale / IMAGE_ZOOM_FACTOR;
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, next));
}
