const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FONT_SIZE_RE = /^(?:14|16|18|20|24)px$/;

export interface SanitizedTextStyle {
  color?: string;
  fontSize?: string;
}

function normalizeHexColor(value: string): string | null {
  if (!HEX_COLOR_RE.test(value)) return null;
  const hex = value.toLowerCase();
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

/** Keep only safe hex color + allowlisted px font sizes. */
export function sanitizeTextStyle(style: string): SanitizedTextStyle {
  const result: SanitizedTextStyle = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (prop === "color") {
      const hex = normalizeHexColor(value);
      if (hex) result.color = hex;
    }
    if (prop === "font-size" && FONT_SIZE_RE.test(value)) {
      result.fontSize = value;
    }
  }
  return result;
}

export const NOTE_FONT_SIZES = ["14", "16", "18", "20", "24"] as const;
export type NoteFontSize = (typeof NOTE_FONT_SIZES)[number];

export const NOTE_COLORS = [
  "default",
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const NOTE_COLOR_HEX: Record<Exclude<NoteColor, "default">, string> = {
  gray: "#6b7280",
  red: "#dc2626",
  orange: "#ea580c",
  yellow: "#ca8a04",
  green: "#16a34a",
  blue: "#2563eb",
  purple: "#7c3aed",
  pink: "#db2777",
};

export function noteColorToHex(color: NoteColor): string | null {
  if (color === "default") return null;
  return NOTE_COLOR_HEX[color];
}

export function hexToNoteColor(hex: string | null | undefined): NoteColor {
  if (!hex) return "default";
  const normalized = normalizeHexColor(hex);
  if (!normalized) return "default";
  const found = (Object.entries(NOTE_COLOR_HEX) as [Exclude<NoteColor, "default">, string][]).find(
    ([, value]) => value === normalized,
  );
  return found?.[0] ?? "default";
}

export function fontSizeToCss(size: NoteFontSize): string {
  return `${size}px`;
}

export function cssToNoteFontSize(value: string | null | undefined): NoteFontSize | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+)px$/);
  const size = match?.[1];
  return size && (NOTE_FONT_SIZES as readonly string[]).includes(size)
    ? (size as NoteFontSize)
    : null;
}
