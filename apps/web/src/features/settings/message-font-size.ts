import { createDevicePreference } from "./device-preference";

const STORAGE_KEY = "coforge-message-font-size";

/** The ordered choices, small to large: 12, 14 and 16px body text. Medium is the default. */
export const MESSAGE_FONT_SIZES = ["sm", "md", "lg"] as const;
export type MessageFontSize = (typeof MESSAGE_FONT_SIZES)[number];

const CLASSES = { sm: "message-font-sm", lg: "message-font-lg" } as const;

export function parseMessageFontSize(stored: string | null): MessageFontSize {
  return stored === "sm" || stored === "lg" ? stored : "md";
}

/** The class on <html> for a size; `message-markdown.css` scales the message text under it. */
export function messageFontSizeClass(size: MessageFontSize): string | undefined {
  return size === "md" ? undefined : CLASSES[size];
}

/** The boot script's part (in __root.tsx), built from the key and classes above so the script and
 * `parseMessageFontSize` cannot disagree about what is stored. */
export const MESSAGE_FONT_SIZE_BOOT = `var messageFontSize=localStorage.getItem("${STORAGE_KEY}");if(messageFontSize==="sm"||messageFontSize==="lg"){document.documentElement.classList.add(${JSON.stringify(CLASSES)}[messageFontSize])}`;

/** Per-device preference: the size of rendered message text (body, headings, code, chips). The
 * rest of the UI keeps its size; Settings → Text size scales everything, this on top of it. */
const preference = createDevicePreference<MessageFontSize>({
  key: STORAGE_KEY,
  parse: parseMessageFontSize,
  serialize: (size) => size,
  fallback: "md",
  apply: (size) => {
    for (const className of Object.values(CLASSES))
      document.documentElement.classList.toggle(
        className,
        className === messageFontSizeClass(size),
      );
  },
});

export const useMessageFontSize = preference.useValue;
