import { stripVTControlCharacters } from "node:util";

export function terminalText(value: string): string {
  return [...stripVTControlCharacters(value)]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join("");
}
