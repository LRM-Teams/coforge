/**
 * The pre-paint half of a stored-class rule: a fragment of JavaScript that adds `className` to
 * `<html>` when `key` holds `token`, so SSR markup never depends on the class. `__root.tsx`
 * concatenates these into the single script it runs before paint.
 *
 * Three settings pre-paint this way: `RAIL_LABELS_BOOT` and `HIDE_EMPTY_SIDEBAR_SECTIONS_BOOT`
 * (both fed `DEVICE_FLAG_HIDDEN`) and `MESSAGE_WIDTH_BOOT` (fed `"full"`, which is why this is not
 * part of `device-flag.ts`: that module's readers answer a show/hide question, and this one only
 * knows about a token).
 *
 * Two other settings pre-paint in a different shape and are deliberately not built from this:
 * `MESSAGE_FONT_SIZE_BOOT` maps one token onto one of several classes, and
 * `TASK_DISPLAY_FIELDS_BOOT` / `TASK_HIDDEN_COLUMNS_BOOT` add one class per entry of a stored list.
 *
 * The fragment reads `localStorage` directly, unlike the callers, because it runs as text before
 * any module does.
 */
export function bootFragment({
  key,
  token,
  className,
}: {
  key: string;
  token: string;
  className: string;
}): string {
  return `if(localStorage.getItem("${key}")==="${token}"){document.documentElement.classList.add("${className}")}`;
}
