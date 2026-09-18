const STORAGE_KEY = "coforge-text-size";

export type TextSizeValue = "sm" | "default" | "lg" | "xl" | "xxl";

interface TextSizeOption {
  value: TextSizeValue;
  /** Percentage applied to the root font size; 100 is the designed default. */
  percent: number;
}

/** Single source of truth for the ordered text-size choices, small to huge. */
export const TEXT_SIZE_OPTIONS: TextSizeOption[] = [
  { value: "sm", percent: 90 },
  { value: "default", percent: 100 },
  { value: "lg", percent: 110 },
  { value: "xl", percent: 125 },
  { value: "xxl", percent: 140 },
];

function isTextSizeValue(value: string | null): value is TextSizeValue {
  return TEXT_SIZE_OPTIONS.some((option) => option.value === value);
}

export function textSizePercent(value: TextSizeValue): number {
  return TEXT_SIZE_OPTIONS.find((option) => option.value === value)?.percent ?? 100;
}

/** Per-device preference: scales the whole UI (all sizes are rem) via the root font size.
 *  Applied as an inline style on <html> (also by the boot script in __root.tsx) so SSR
 *  markup never depends on it. */
export function readTextSize(): TextSizeValue {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTextSizeValue(stored) ? stored : "default";
  } catch {
    return "default";
  }
}

export function writeTextSize(value: TextSizeValue) {
  try {
    if (value === "default") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, value);
    }
  } catch {
    // Private mode or blocked storage: the inline style still applies for this page.
  }
  if (value === "default") {
    document.documentElement.style.fontSize = "";
  } else {
    document.documentElement.style.fontSize = `${textSizePercent(value)}%`;
  }
}
