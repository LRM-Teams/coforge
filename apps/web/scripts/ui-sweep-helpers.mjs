/**
 * @param {any} element
 * @param {number} viewportWidth
 * @param {(element: any) => { overflowX: string }} getStyle
 */
export function isInsideViewportScroller(element, viewportWidth, getStyle = getComputedStyle) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowX = getStyle(parent).overflowX;
    if (
      (overflowX === "auto" || overflowX === "scroll") &&
      parent.scrollWidth > parent.clientWidth + 1
    ) {
      const rect = parent.getBoundingClientRect();
      return rect.left >= -2 && rect.right <= viewportWidth + 2;
    }
  }
  return false;
}

export function filterSweepOptions(values, filter, label) {
  if (!filter) return values;
  const requested = new Set(
    filter
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const selected = values.filter((value) => requested.has(value.name ?? value));
  if (selected.length !== requested.size) {
    throw new Error(`Unknown ${label} filter: ${filter}`);
  }
  return selected;
}
