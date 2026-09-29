import { describe, expect, test } from "bun:test";

import { messageFontSizeClass, parseMessageFontSize } from "./message-font-size";

describe("message font size", () => {
  test("a device that never chose one, or stored something else, reads as Medium", () => {
    expect(parseMessageFontSize(null)).toBe("md");
    expect(parseMessageFontSize("huge")).toBe("md");
  });

  test("a stored Small or Large reads back", () => {
    expect(parseMessageFontSize("sm")).toBe("sm");
    expect(parseMessageFontSize("lg")).toBe("lg");
  });

  test("only Small and Large put a class on the document; Medium, the default, sets none", () => {
    expect(messageFontSizeClass("sm")).toBe("message-font-sm");
    expect(messageFontSizeClass("lg")).toBe("message-font-lg");
    expect(messageFontSizeClass("md")).toBeUndefined();
  });
});
