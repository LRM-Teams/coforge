/** True while an IME composition is in progress (or Safari keyCode 229). */
export function isImeComposing(event: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  const e = event.nativeEvent ?? event;
  return Boolean(e.isComposing) || e.keyCode === 229;
}
